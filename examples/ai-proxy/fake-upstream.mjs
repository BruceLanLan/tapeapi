#!/usr/bin/env node
// A tiny FAKE AI API to put the sidecar in front of, in the three wire formats clients speak: OpenAI Chat Completions
// (/v1/chat/completions, JSON and server-sent events, usage in a last chunk only when stream_options.include_usage is
// set), OpenAI Responses (/v1/responses, typed events ending in response.completed), Anthropic Messages (/v1/messages,
// message_start ... message_stop, with ping; /v1/messages/count_tokens), plus /v1/embeddings, /v1/completions and
// /v1/models. It stands for YOUR upstream (a gateway such as new-api, an aggregator, your own model server): nothing in
// it knows about TapeAPI, it calls no real model and needs no real key. Token counts are words.
// 一个很小的**模拟** AI 接口，说客户端用的三种格式：OpenAI Chat Completions、OpenAI Responses、Anthropic Messages，另有
// embeddings、completions、models。它代表**你的**上游（new-api 这类网关、聚合商、自建模型服务）：里面没有任何 TapeAPI 的
// 东西，不调用真实模型，也不需要真实密钥。token 数按单词计。
//
//   node examples/openai-proxy/fake-upstream.mjs     # http://127.0.0.1:8799/v1, accepts the key sk-demo
import http from 'node:http'
import { fileURLToPath } from 'node:url'

export const DEMO_KEY = 'sk-demo'
export const MODELS = ['demo-chat', 'demo-claude', 'demo-embed']

const words = (s) => String(s ?? '').split(/\s+/).filter(Boolean)
const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'x-request-id': `req_${Math.random().toString(36).slice(2, 10)}`, ...headers } })
const oaError = (status, message, type, code = null) => json(status, { error: { message, type, param: null, code } })
let seq = 0
const newId = (p) => `${p}-${Date.now().toString(36)}${(seq++).toString(36)}`

/**
 * The fake API as a fetch-style handler: (Request) -> Response. Keys it accepts: `keys` (default [DEMO_KEY]).
 * `chunkDelayMs` spaces the stream's events out, as a real model does. / 以 fetch 风格处理请求的模拟接口。
 */
export function createFakeUpstream({ keys = [DEMO_KEY], chunkDelayMs = 0 } = {}) {
  async function handle(request) {
    const url = new URL(request.url)
    const auth = request.headers.get('x-api-key') || (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '')
    if (!keys.includes(auth)) return oaError(401, 'Incorrect API key provided.', 'invalid_request_error', 'invalid_api_key')
    if (request.method === 'GET' && url.pathname === '/v1/models') {
      return json(200, { object: 'list', data: MODELS.map((id) => ({ id, object: 'model', created: 1790000000, owned_by: 'demo' })) })
    }
    if (request.method !== 'POST') return oaError(404, `Unknown request URL: ${request.method} ${url.pathname}`, 'invalid_request_error')
    let body
    try { body = JSON.parse(await request.text()) } catch { return oaError(400, 'We could not parse the JSON body of your request.', 'invalid_request_error') }
    const model = typeof body.model === 'string' ? body.model : ''
    if (!model) return oaError(400, 'you must provide a model parameter', 'invalid_request_error')
    const created = Math.floor(Date.now() / 1000)

    if (url.pathname === '/v1/embeddings') {
      const inputs = Array.isArray(body.input) ? body.input : [body.input]
      const prompt = inputs.reduce((n, x) => n + words(x).length, 0)
      return json(200, { object: 'list', model, data: inputs.map((x, index) => ({ object: 'embedding', index, embedding: [words(x).length / 10, 0.5, -0.25] })), usage: { prompt_tokens: prompt, total_tokens: prompt } })
    }
    if (url.pathname === '/v1/completions') {
      const text = ` ${words(body.prompt).reverse().join(' ')}`
      const p = words(body.prompt).length, c = words(text).length
      return json(200, { id: newId('cmpl'), object: 'text_completion', created, model, choices: [{ index: 0, text, finish_reason: 'stop', logprobs: null }], usage: { prompt_tokens: p, completion_tokens: c, total_tokens: p + c } })
    }
    const te = new TextEncoder()
    const sse = (lines) => {
      let i = 0
      const stream = new ReadableStream({
        async pull(controller) {
          if (i >= lines.length) return controller.close()
          if (chunkDelayMs) await new Promise((r) => setTimeout(r, chunkDelayMs))
          controller.enqueue(te.encode(lines[i++]))
        },
      })
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', 'x-request-id': `req_${newId('s')}` } })
    }
    const typed = (type, o) => `event: ${type}\ndata: ${JSON.stringify({ type, ...o })}\n\n`
    const said = (input) => `You said: ${typeof input === 'string' ? input : JSON.stringify(input ?? '')}`

    if (url.pathname === '/v1/messages/count_tokens') {
      return json(200, { input_tokens: (Array.isArray(body.messages) ? body.messages : []).reduce((n, m) => n + words(typeof m?.content === 'string' ? m.content : '').length, 0) })
    }
    if (url.pathname === '/v1/messages') {
      const msgs = Array.isArray(body.messages) ? body.messages : []
      const last = [...msgs].reverse().find((m) => m?.role === 'user')?.content
      const reply = said(last)
      // A little of the prompt "comes from the cache", to show the cache prices at work. / 一小部分提示"来自缓存"，以展示缓存价。
      const input = msgs.reduce((n, m) => n + words(typeof m?.content === 'string' ? m.content : '').length, 0)
      const usage = { input_tokens: input, cache_creation_input_tokens: 0, cache_read_input_tokens: 2, output_tokens: words(reply).length }
      const id = newId('msg')
      const message = { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 1 } }
      if (!body.stream) return json(200, { ...message, content: [{ type: 'text', text: reply }], stop_reason: 'end_turn', usage })
      return sse([
        typed('message_start', { message }), typed('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }), 'event: ping\ndata: {"type": "ping"}\n\n',
        ...words(reply).map((w, i) => typed('content_block_delta', { index: 0, delta: { type: 'text_delta', text: (i ? ' ' : '') + w } })),
        typed('content_block_stop', { index: 0 }), typed('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: usage.output_tokens } }), typed('message_stop', {}),
      ])
    }
    if (url.pathname === '/v1/responses') {
      const reply = said(body.input)
      const input = words(typeof body.input === 'string' ? body.input : JSON.stringify(body.input ?? '')).length
      const usage = { input_tokens: input, input_tokens_details: { cached_tokens: 0 }, output_tokens: words(reply).length, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: input + words(reply).length }
      const id = newId('resp')
      const base = { id, object: 'response', created_at: created, model, status: 'in_progress', output: [] }
      const done = { ...base, status: 'completed', output: [{ type: 'message', id: newId('msg'), role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: reply, annotations: [] }] }], usage }
      if (!body.stream) return json(200, done)
      let seq = 0
      return sse([
        typed('response.created', { sequence_number: seq++, response: base }),
        ...words(reply).map((w, i) => typed('response.output_text.delta', { sequence_number: seq++, item_id: 'msg_0', output_index: 0, content_index: 0, delta: (i ? ' ' : '') + w })),
        typed('response.completed', { sequence_number: seq++, response: done }),
      ])
    }
    if (url.pathname !== '/v1/chat/completions') return oaError(404, `Unknown request URL: POST ${url.pathname}`, 'invalid_request_error')
    const messages = Array.isArray(body.messages) ? body.messages : []
    const last = [...messages].reverse().find((m) => m?.role === 'user')?.content ?? ''
    const reply = `You said: ${String(last)}`
    const p = messages.reduce((n, m) => n + words(m?.content).length, 0), c = words(reply).length
    const usage = { prompt_tokens: p, completion_tokens: c, total_tokens: p + c }
    const id = newId('chatcmpl')
    if (!body.stream) {
      return json(200, { id, object: 'chat.completion', created, model, choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop', logprobs: null }], usage })
    }
    const chunk = (delta, finish = null, extra = {}) => ({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finish, logprobs: null }], ...extra })
    const events = [chunk({ role: 'assistant', content: '' }), ...words(reply).map((w, i) => chunk({ content: (i ? ' ' : '') + w })), chunk({}, 'stop')]
    if (body.stream_options?.include_usage) events.push({ id, object: 'chat.completion.chunk', created, model, choices: [], usage })
    return sse([...events.map((e) => `data: ${JSON.stringify(e)}\n\n`), 'data: [DONE]\n\n'])
  }
  // The same as a `fetch` (for an in-process upstream). / 同一个接口的 fetch 形式（进程内上游）。
  const fetch = async (input, init) => handle(new Request(input, init))
  return { handle, fetch }
}

/** Serve the fake API on host:port (0 = any free port). Resolves with { baseUrl, close }. / 在 host:port 上提供模拟接口。 */
export async function startFakeUpstream({ port = 0, host = '127.0.0.1', ...o } = {}) {
  const { handle } = createFakeUpstream(o)
  const server = http.createServer(async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    const headers = new Headers()
    for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) { try { headers.append(req.rawHeaders[i], req.rawHeaders[i + 1]) } catch { /* not a fetch header */ } }
    const r = await handle(new Request(new URL(req.url, `http://${host}`), { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks) }))
    res.writeHead(r.status, Object.fromEntries(r.headers))
    if (!r.body) return res.end()
    for await (const c of r.body) res.write(c)
    res.end()
  })
  await new Promise((resolve, reject) => server.once('error', reject).listen(port, host, resolve))
  return { baseUrl: `http://${host}:${server.address().port}/v1`, close: () => new Promise((r) => server.close(() => r())) }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { baseUrl } = await startFakeUpstream({ port: Number(process.env.PORT || 8799), host: process.env.HOST || '127.0.0.1' })
  console.log(`[fake-openai] OpenAI-compatible API (fake) on ${baseUrl}; key ${DEMO_KEY}; models ${MODELS.join(', ')}`)
}
