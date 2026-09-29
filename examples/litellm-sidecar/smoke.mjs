#!/usr/bin/env node
// A local run of the LiteLLM package without Docker and without LiteLLM: the sidecar's own entry (server.mjs) in front
// of the repository's FAKE upstream (examples/ai-proxy/fake-upstream.mjs: no real model, no real key), reshaped the way
// LiteLLM Proxy 1.103.0 frames its answers (startLiteLLMShapedUpstream: Responses events as `data:` lines only, ended
// by `data: [DONE]`; the Chat usage chunk with `choices: [{ index: 0, delta: {} }]`; LiteLLM's x-litellm-* headers).
// It makes Chat (plain and streamed), Responses (plain and streamed), Anthropic Messages (streamed) and Embeddings
// calls the way clients make them and checks every receipt with the SDK's ai.verifyUsageReceipt over the exact bytes.
// A real LiteLLM run is e2e.mjs. The identity is a throwaway (examples/new-api-sidecar/smoke.mjs): nothing is on chain.
// 不用 Docker、也不用 LiteLLM 的本地演练：旁路自己的入口放在仓库的**模拟**上游前面，模拟上游按 LiteLLM Proxy 1.103.0 的方式改写
// 回答（Responses 事件只有 data 行、以 `data: [DONE]` 结束；Chat 的 usage 块带 `choices: [{ index: 0, delta: {} }]`；带上 LiteLLM 的
// x-litellm-* 响应头）。按客户端的方式调用，并用 SDK 的 ai.verifyUsageReceipt 按确切字节核验每一份回执。真实 LiteLLM 的演练见 e2e.mjs。
//
//   node examples/litellm-sidecar/smoke.mjs
import http from 'node:http'
import { fileURLToPath } from 'node:url'
import { ai } from '@tapeapi/sdk'
import { createFakeUpstream } from '../ai-proxy/fake-upstream.mjs'
import { throwawayIdentity, callAndVerify } from '../new-api-sidecar/smoke.mjs'
import { startSidecar } from './server.mjs'

export { throwawayIdentity, callAndVerify }
export const EXAMPLE_MODELS = fileURLToPath(new URL('models.example.json', import.meta.url))
const te = new TextEncoder()

/**
 * An answer of the fake upstream, reframed as LiteLLM Proxy 1.103.0 frames it (observed on a local proxy in front of
 * the same fake upstream; see README "依据 / Sources"). / 把模拟上游的回答改写成 LiteLLM Proxy 1.103.0 的样子。
 */
export async function asLiteLLM(path, res) {
  const headers = new Headers(res.headers)
  headers.set('x-litellm-version', '1.103.0')
  headers.set('x-litellm-call-id', crypto.randomUUID())
  headers.set('x-litellm-response-cost', '8.5e-06')
  const stream = (res.headers.get('content-type') || '').includes('text/event-stream')
  if (!stream || !res.body) return new Response(res.body, { status: res.status, headers })
  let text = await res.text()
  if (path === '/v1/responses') text = text.replace(/^event: [^\n]*\n/gm, '') + 'data: [DONE]\n\n'
  if (path === '/v1/chat/completions') {
    text = text.replace(/^data: (\{.*\})$/gm, (line, j) => {
      const o = JSON.parse(j)
      return Array.isArray(o.choices) && o.choices.length === 0 && o.usage ? `data: ${JSON.stringify({ ...o, choices: [{ index: 0, delta: {} }] })}` : line
    })
  }
  headers.delete('content-length')
  const events = text.split(/(?<=\n\n)/)
  return new Response(new ReadableStream({ pull(c) { if (events.length) c.enqueue(te.encode(events.shift())); else c.close() } }), { status: res.status, headers })
}

/** The fake upstream, LiteLLM-shaped, on host:port (0 = any). / 按 LiteLLM 改写的模拟上游。 */
export async function startLiteLLMShapedUpstream({ port = 0, host = '127.0.0.1', ...o } = {}) {
  const { handle } = createFakeUpstream(o)
  const server = http.createServer(async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    const headers = new Headers()
    for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) { try { headers.append(req.rawHeaders[i], req.rawHeaders[i + 1]) } catch { /* not a fetch header */ } }
    const url = new URL(req.url, `http://${host}`)
    const r = await asLiteLLM(url.pathname, await handle(new Request(url, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks) })))
    res.writeHead(r.status, Object.fromEntries(r.headers))
    if (!r.body) return res.end()
    for await (const c of r.body) res.write(c)
    res.end()
  })
  await new Promise((resolve, reject) => server.once('error', reject).listen(port, host, resolve))
  return { baseUrl: `http://${host}:${server.address().port}/v1`, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()) }) }
}

/**
 * The sidecar in front of an upstream: the LiteLLM-shaped fake by default, or `upstreamBaseUrl` (a real LiteLLM).
 * 旁路放在上游前面：默认是按 LiteLLM 改写的模拟上游，或 upstreamBaseUrl（真实的 LiteLLM）。
 */
export async function startStack({ env = {}, quiet = true, upstreamBaseUrl = null, start = startSidecar } = {}) {
  const fake = upstreamBaseUrl ? null : await startLiteLLMShapedUpstream()
  let sidecar
  try {
    sidecar = await start({
      env: { ...throwawayIdentity(), UPSTREAM_BASE_URL: upstreamBaseUrl ?? fake.baseUrl, MODELS_FILE: EXAMPLE_MODELS, SERVICE_NAME: 'Smoke LiteLLM relay', ...env },
      port: 0, host: '127.0.0.1', quiet, localPublicUrl: true, log: () => {},
    })
  } catch (e) { await fake?.close(); throw e }
  if (!sidecar.state.ok) { await sidecar.close(); await fake?.close(); throw new Error(`the sidecar is in setup mode: ${sidecar.state.problem || sidecar.state.missing.join(', ')}`) }
  const manifest = await (await fetch(`${sidecar.url}/.well-known/tapeapi.json`)).json()
  return { fake, sidecar, manifest, close: async () => { await sidecar.close(); await fake?.close() } }
}

// The model names are LiteLLM's model_name values (config.example.yaml), which LiteLLM reports back in `model`.
// 模型名就是 LiteLLM 的 model_name（config.example.yaml），LiteLLM 在回答的 model 里报告的也是它。
export const CALLS = [
  { label: 'OpenAI Chat', format: 'openai-chat', path: '/v1/chat/completions', body: { model: 'gpt-5-mini', messages: [{ role: 'user', content: 'Hello through the sidecar' }] } },
  { label: 'OpenAI Chat, streamed', format: 'openai-chat', path: '/v1/chat/completions', body: { model: 'deepseek-chat', stream: true, messages: [{ role: 'user', content: 'Stream this please' }] } },
  { label: 'OpenAI Responses', format: 'openai-responses', path: '/v1/responses', body: { model: 'gpt-5-mini', input: 'What does the receipt prove' } },
  { label: 'OpenAI Responses, streamed', format: 'openai-responses', path: '/v1/responses', body: { model: 'gpt-5-mini', stream: true, input: 'What does the receipt prove' } },
  { label: 'Anthropic Messages, streamed', format: 'anthropic-messages', path: '/v1/messages', body: { model: 'claude-sonnet-4-5', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'Hi from Claude Code' }] } },
  { label: 'OpenAI Embeddings', format: 'openai-embeddings', path: '/v1/embeddings', body: { model: 'text-embedding-3-small', input: 'tape out' } },
]

/**
 * What a client should see, beyond a verified receipt: in an event stream the receipt comes before the end (before
 * `data: [DONE]`, or before `message_stop`), and a Chat stream that did not ask for usage carries no usage chunk.
 * 除了回执核验通过，客户端还应看到：事件流里回执在结束之前（`data: [DONE]` 或 `message_stop` 之前）；没要 usage 的 Chat 流不带 usage 块。
 */
export function streamProblems({ path, body, responseBytes }) {
  const text = new TextDecoder().decode(responseBytes)
  const problems = []
  const at = text.indexOf(': tapeapi-receipt ')
  const end = Math.max(text.lastIndexOf('data: [DONE]'), text.lastIndexOf('event: message_stop'))
  if (at < 0) problems.push('no receipt comment')
  else if (end >= 0 && at > end) problems.push('the receipt comes after the end of the stream')
  if (path === '/v1/chat/completions' && body.stream && !body.stream_options?.include_usage && /"usage":/.test(text)) problems.push('a usage chunk the client did not ask for')
  return problems
}

async function main() {
  const stack = await startStack({ quiet: false })
  let failed = 0
  try {
    console.log(`[smoke] sidecar ${stack.sidecar.url} -> LiteLLM-shaped fake upstream ${stack.fake.baseUrl}; signer ${stack.manifest.signer}`)
    for (const c of CALLS) {
      const { res, stream, envelope, verdict, responseBytes } = await callAndVerify({ manifest: stack.manifest, ...c })
      const r = envelope?.result
      const extra = stream ? streamProblems({ path: c.path, body: c.body, responseBytes }) : []
      const priced = r?.prices ? r.prices.map((p) => `${p.amount} ${p.currency}`).join(' / ') : 'unpriced'
      const good = res.status === 200 && verdict.ok && !!r?.prices && r.complete === true && !extra.length
      if (!good) failed++
      console.log(`[smoke] ${good ? 'OK  ' : 'FAIL'} ${c.label.padEnd(29)} HTTP ${res.status} ${stream ? 'stream' : 'json  '} model=${r?.model} by=${r?.modelMatchedBy} ` +
        `tokens=${r?.usage ? `${r.usage.prompt_tokens}+${r.usage.completion_tokens}` : '-'} ${priced}${r?.usageInjected ? ' (usage injected)' : ''}` +
        `${[...verdict.problems, ...extra].length ? `  problems: ${[...verdict.problems, ...extra].join('; ')}` : ''}`)
    }
    const first = await callAndVerify({ manifest: stack.manifest, ...CALLS[0] })
    const got = await (await fetch(`${stack.sidecar.url}/tapeapi/v1/${ai.RECEIPT_METHOD}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'smoke', params: { id: first.envelope.id } }) })).json()
    const same = got.ok && got.result?.sig === first.envelope.sig
    if (!same) failed++
    console.log(`[smoke] ${same ? 'OK  ' : 'FAIL'} receipt by id ${first.envelope.id}`)
  } finally { await stack.close() }
  console.log(failed ? `[smoke] ${failed} check(s) FAILED` : '[smoke] every receipt verified')
  process.exit(failed ? 1 : 0)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main()
