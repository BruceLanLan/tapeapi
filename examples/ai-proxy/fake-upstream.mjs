#!/usr/bin/env node
// A small FAKE AI API to put the sidecar in front of, in the wire formats clients speak: OpenAI Chat Completions
// (/v1/chat/completions, JSON and server-sent events, usage in a last chunk only when stream_options.include_usage is
// set), OpenAI Responses (/v1/responses, the typed event ladder response.created ... response.completed, with reasoning,
// message and function_call items), Anthropic Messages (/v1/messages, message_start ... message_stop with thinking,
// text and tool_use blocks, ping events and cache usage; /v1/messages/count_tokens), plus /v1/embeddings,
// /v1/completions and /v1/models (Anthropic's list shape when the request carries anthropic-version). It stands for YOUR
// upstream (a gateway such as new-api, an aggregator, your own model server): nothing in it knows about TapeAPI, it
// calls no real model and needs no real key. Token counts are words.
// 一个小的**模拟** AI 接口，说客户端用的几种格式：OpenAI Chat Completions、OpenAI Responses（完整的类型化事件序列，含
// reasoning、message、function_call 项）、Anthropic Messages（thinking、text、tool_use 块，ping 事件与缓存用量；
// count_tokens），另有 embeddings、completions、models（请求带 anthropic-version 时按 Anthropic 的列表格式）。它代表**你的**
// 上游：里面没有任何 TapeAPI 的东西，不调用真实模型，也不需要真实密钥。token 数按单词计。
//
// Scriptable, so a real client (Claude Code, Codex) can be driven through a tool-use turn / 可编排：
// - `script`: a list of turns used in order by /v1/messages and /v1/responses, or a function (ctx) -> turn; a turn is
//   { text?, thinking?, tool?: { name, input } }. When it is absent or used up, the turn comes from the prompt:
// - the last user text may carry directives: `[[tool:NAME {json input}]]` answers with that tool call, `[[think]]` adds a
//   thinking (Anthropic) / reasoning (Responses) block; after a tool result the answer is text that quotes it.
// - `onRequest({ method, path, search, headers, body })` sees every request (a recorder for tests).
//
//   node examples/ai-proxy/fake-upstream.mjs     # http://127.0.0.1:8799/v1, accepts the key sk-demo
import http from 'node:http'
import { fileURLToPath } from 'node:url'

export const DEMO_KEY = 'sk-demo'
export const MODELS = ['demo-chat', 'demo-claude', 'demo-embed']
const DEFAULT_MODELS = MODELS

const words = (s) => String(s ?? '').split(/\s+/).filter(Boolean)
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
// Every string inside a value, in order (a message's text however it is nested). / 值里的全部字符串，按顺序。
const strings = (v) => (typeof v === 'string' ? [v] : Array.isArray(v) ? v.flatMap(strings) : isObj(v) ? Object.values(v).flatMap(strings) : [])
const wordsIn = (v) => strings(v).reduce((n, s) => n + words(s).length, 0)
const reqId = () => `req_${Math.random().toString(36).slice(2, 12)}`
const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'x-request-id': reqId(), ...headers } })
const oaError = (status, message, type, code = null) => json(status, { error: { message, type, param: null, code } })
const anError = (status, type, message, headers = {}) => json(status, { type: 'error', error: { type, message }, request_id: reqId() }, { 'request-id': reqId(), ...headers })
let seq = 0
const newId = (p) => `${p}-${Date.now().toString(36)}${(seq++).toString(36)}`
const sigOf = (s) => Buffer.from(`fake-signature:${s}`).toString('base64')
const pieces = (s, n = 3) => { const out = []; for (let i = 0; i < s.length; i += Math.max(1, Math.ceil(s.length / n))) out.push(s.slice(i, i + Math.ceil(s.length / n))); return out.length ? out : [''] }

// A tool's JSON input in three deltas, cut after the first key and before the closing brace (a value arrives whole).
// 工具的 JSON 输入分三段：第一个键之后、右花括号之前切开（值完整到达）。
const jsonPieces = (s) => { const k = s.indexOf(':'); return k < 0 || s.length < 3 ? [s] : [s.slice(0, k + 1), s.slice(k + 1, -1), s.slice(-1)] }

const DIRECTIVE_TOOL = /\[\[tool:([A-Za-z0-9_.:-]+)\s+(\{[\s\S]*?\})\]\]/
const DIRECTIVE_THINK = /\[\[think\]\]/
// Failures, each once per client session (the retry then succeeds): an HTTP error, or a stream cut short.
// 失败，每个客户端会话只发生一次（重试随即成功）：HTTP 错误，或中途断掉的流。
const DIRECTIVE_FAIL = /\[\[fail:(\d{3})\]\]/
const DIRECTIVE_CUT = /\[\[cut\]\]/
const clean = (s) => s.replace(new RegExp(DIRECTIVE_TOOL.source, 'g'), '').replace(/\[\[(think|cut|fail:\d{3})\]\]/g, '').replace(/\s+/g, ' ').trim()

/** The turn the prompt asks for (directives), or a plain reply. / 提示所要求的回合（指令），否则是一句普通回复。 */
function turnFromPrompt({ lastUserText, toolResult }) {
  if (toolResult !== null) return { text: `Done. The tool returned: ${clean(toolResult).slice(0, 300)}` }
  const t = String(lastUserText ?? '')
  const turn = { text: `Hi! You said: ${clean(t).slice(0, 200) || '(nothing)'}` }
  const m = DIRECTIVE_TOOL.exec(t)
  if (m) { let input; try { input = JSON.parse(m[2]) } catch { input = {} } turn.tool = { name: m[1], input }; turn.text = 'Let me check.' }
  if (DIRECTIVE_THINK.test(t)) turn.thinking = 'The user wants a short answer; I will keep it brief.'
  const f = DIRECTIVE_FAIL.exec(t)
  if (f) turn.fail = Number(f[1])
  if (DIRECTIVE_CUT.test(t)) turn.cut = true
  return turn
}

// ---- Anthropic Messages: the last user text, and a tool result if the last user message carries one ----
function anthropicCtx(body) {
  const msgs = Array.isArray(body.messages) ? body.messages : []
  const last = msgs[msgs.length - 1]
  let toolResult = null
  if (last?.role === 'user' && Array.isArray(last.content)) {
    const r = last.content.find((b) => b?.type === 'tool_result')
    if (r) toolResult = strings(r.content).join(' ') || '(empty)'
  }
  let lastUserText = ''
  for (const m of [...msgs].reverse()) {
    if (m?.role !== 'user') continue
    if (typeof m.content === 'string') { lastUserText = m.content; break }
    const texts = (Array.isArray(m.content) ? m.content : []).filter((b) => b?.type === 'text' && !/^\s*<system-reminder>/.test(b.text ?? '')).map((b) => b.text)
    if (texts.length) { lastUserText = texts[texts.length - 1]; break }
  }
  return { lastUserText, toolResult }
}
// ---- OpenAI Responses: the same from `input` ----
function responsesCtx(body) {
  const input = typeof body.input === 'string' ? [{ role: 'user', content: body.input }] : Array.isArray(body.input) ? body.input : []
  const last = input[input.length - 1]
  const toolResult = last?.type === 'function_call_output' ? (typeof last.output === 'string' ? last.output : strings(last.output).join(' ')) || '(empty)' : null
  let lastUserText = ''
  for (const it of [...input].reverse()) {
    if (it?.role !== 'user') continue
    const texts = typeof it.content === 'string' ? [it.content] : (Array.isArray(it.content) ? it.content : []).filter((c) => c?.type === 'input_text').map((c) => c.text)
    const real = texts.filter((x) => !/^\s*<(environment_context|user_instructions|skills_instructions)/.test(x ?? ''))
    if (real.length) { lastUserText = real[real.length - 1]; break }
  }
  return { lastUserText, toolResult }
}

/**
 * The fake API as a fetch-style handler: (Request) -> Response. Keys it accepts: `keys` (default [DEMO_KEY]).
 * `chunkDelayMs` spaces the stream's events out, as a real model does. / 以 fetch 风格处理请求的模拟接口。
 * `models` is what /v1/models lists (any model id is answered). / models 是 /v1/models 列出的模型（任何模型 id 都会作答）。
 * @param {{ keys?: string[], chunkDelayMs?: number, models?: string[], script?: object[] | ((ctx: object) => object), onRequest?: (r: object) => void }} [o]
 */
export function createFakeUpstream({ keys = [DEMO_KEY], chunkDelayMs = 0, models: MODELS = DEFAULT_MODELS, script, onRequest } = {}) {
  const queue = Array.isArray(script) ? [...script] : null
  const failedOnce = new Set()
  const nextTurn = (ctx) => {
    if (typeof script === 'function') { const t = script(ctx); if (t) return t }
    if (queue && queue.length) return queue.shift()
    const turn = turnFromPrompt(ctx)
    // A failure happens once per session and prompt: the client's retry gets the answer. / 每个会话与提示只失败一次。
    if (turn.fail || turn.cut) {
      const key = `${ctx.session}|${ctx.lastUserText}`
      if (failedOnce.has(key)) { delete turn.fail; delete turn.cut } else failedOnce.add(key)
    }
    return turn
  }
  // The client session, from a header or, when a proxy dropped those, the body (Claude Code's metadata.user_id, Codex's
  // prompt_cache_key). / 客户端会话：取自请求头；代理去掉了这些头时取自正文。
  const sessionOf = (h, body) => h.get('x-claude-code-session-id') || h.get('session-id') || (typeof body?.metadata?.user_id === 'string' && body.metadata.user_id) || (typeof body?.prompt_cache_key === 'string' && body.prompt_cache_key) || 'default'
  async function handle(request) {
    const url = new URL(request.url)
    const raw = request.method === 'GET' || request.method === 'HEAD' ? new Uint8Array(0) : new Uint8Array(await request.arrayBuffer())
    if (onRequest) { try { onRequest({ method: request.method, path: url.pathname, search: url.search, headers: Object.fromEntries(request.headers), body: raw }) } catch { /* a recorder's failure is not ours */ } }
    const anthropic = request.headers.has('anthropic-version') || url.pathname.startsWith('/v1/messages')
    const auth = request.headers.get('x-api-key') || (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '')
    if (!keys.includes(auth)) return anthropic ? anError(401, 'authentication_error', 'invalid x-api-key') : oaError(401, 'Incorrect API key provided.', 'invalid_request_error', 'invalid_api_key')
    if (request.method === 'GET' && (url.pathname === '/v1/models' || url.pathname.startsWith('/v1/models/'))) {
      const one = url.pathname.slice('/v1/models/'.length)
      if (anthropic) {
        const entry = (id) => ({ type: 'model', id, display_name: id, created_at: '2026-09-01T00:00:00Z' })
        if (one) return MODELS.includes(one) ? json(200, entry(one)) : anError(404, 'not_found_error', `model: ${one}`)
        return json(200, { data: MODELS.map(entry), has_more: false, first_id: MODELS[0], last_id: MODELS[MODELS.length - 1] })
      }
      const entry = (id) => ({ id, object: 'model', created: 1790000000, owned_by: 'demo' })
      if (one) return MODELS.includes(one) ? json(200, entry(one)) : oaError(404, `The model '${one}' does not exist`, 'invalid_request_error', 'model_not_found')
      return json(200, { object: 'list', data: MODELS.map(entry) })
    }
    if (request.method !== 'POST') return anthropic ? anError(404, 'not_found_error', `Not found: ${request.method} ${url.pathname}`) : oaError(404, `Unknown request URL: ${request.method} ${url.pathname}`, 'invalid_request_error')
    let body
    try { body = JSON.parse(new TextDecoder().decode(raw)) } catch { return anthropic ? anError(400, 'invalid_request_error', 'The request body is not valid JSON.') : oaError(400, 'We could not parse the JSON body of your request.', 'invalid_request_error') }
    if (!isObj(body)) return oaError(400, 'The body must be a JSON object.', 'invalid_request_error')
    const model = typeof body.model === 'string' ? body.model : ''
    if (!model) return anthropic ? anError(400, 'invalid_request_error', 'model: Field required') : oaError(400, 'you must provide a model parameter', 'invalid_request_error')
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
    const sse = (lines, extraHeaders = {}) => {
      let i = 0
      const stream = new ReadableStream({
        async pull(controller) {
          if (i >= lines.length) return controller.close()
          if (chunkDelayMs) await new Promise((r) => setTimeout(r, chunkDelayMs))
          controller.enqueue(te.encode(lines[i++]))
        },
      })
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', 'x-request-id': reqId(), ...extraHeaders } })
    }
    const typed = (type, o) => `event: ${type}\ndata: ${JSON.stringify({ type, ...o })}\n\n`

    if (url.pathname === '/v1/messages/count_tokens') return json(200, { input_tokens: wordsIn(body.messages) + wordsIn(body.system) })
    if (url.pathname === '/v1/messages') {
      const turn = nextTurn({ format: 'anthropic-messages', body, session: sessionOf(request.headers, body), ...anthropicCtx(body) })
      if (turn.fail) {
        const type = { 429: 'rate_limit_error', 529: 'overloaded_error', 500: 'api_error', 401: 'authentication_error', 400: 'invalid_request_error' }[turn.fail] || 'api_error'
        return anError(turn.fail, type, `fake ${type}`, turn.fail === 429 || turn.fail === 529 ? { 'retry-after': '1', 'x-should-retry': 'true' } : {})
      }
      // Part of the prompt "comes from the cache" (a read and a write), to show the cache prices at work.
      // 一部分提示"来自缓存"（读与写），以展示缓存价。
      const total = Math.max(1, wordsIn(body.messages) + wordsIn(body.system))
      const read = Math.floor(total / 2), write = Math.floor(total / 4), input = total - read - write
      const blocks = []
      if (turn.thinking) blocks.push({ type: 'thinking', thinking: turn.thinking, signature: sigOf(turn.thinking) })
      if (turn.text) blocks.push({ type: 'text', text: turn.text })
      if (turn.tool) blocks.push({ type: 'tool_use', id: `toolu_${newId('t').replace(/-/g, '')}`, name: turn.tool.name, input: turn.tool.input ?? {} })
      const output = Math.max(1, wordsIn(blocks.map((b) => b.thinking ?? b.text ?? JSON.stringify(b.input))))
      const stop = turn.tool ? 'tool_use' : 'end_turn'
      const cacheUsage = { cache_creation_input_tokens: write, cache_read_input_tokens: read, cache_creation: { ephemeral_5m_input_tokens: write, ephemeral_1h_input_tokens: 0 } }
      const usage = { input_tokens: input, ...cacheUsage, output_tokens: output, service_tier: 'standard' }
      const id = `msg_${newId('m').replace(/-/g, '')}`
      const message = { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 1 } }
      const hdr = { 'request-id': reqId(), 'anthropic-organization-id': '00000000-0000-4000-8000-000000000000' }
      if (!body.stream) return json(200, { ...message, content: blocks, stop_reason: stop, usage }, hdr)
      const lines = [typed('message_start', { message }), typed('ping', {})]
      blocks.forEach((b, index) => {
        if (b.type === 'thinking') {
          lines.push(typed('content_block_start', { index, content_block: { type: 'thinking', thinking: '', signature: '' } }))
          for (const p of pieces(b.thinking)) lines.push(typed('content_block_delta', { index, delta: { type: 'thinking_delta', thinking: p } }))
          lines.push(typed('content_block_delta', { index, delta: { type: 'signature_delta', signature: b.signature } }))
        } else if (b.type === 'text') {
          lines.push(typed('content_block_start', { index, content_block: { type: 'text', text: '' } }))
          words(b.text).forEach((w, i) => lines.push(typed('content_block_delta', { index, delta: { type: 'text_delta', text: (i ? ' ' : '') + w } })))
        } else {
          lines.push(typed('content_block_start', { index, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } }))
          lines.push(typed('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: '' } }))
          for (const p of jsonPieces(JSON.stringify(b.input))) lines.push(typed('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: p } }))
        }
        lines.push(typed('content_block_stop', { index }))
        if (index === 0) lines.push(typed('ping', {}))
      })
      // Cut short: the API's mid-stream error event, no message_delta, no message_stop. / 中途出错：错误事件，没有 message_stop。
      if (turn.cut) return sse([...lines.slice(0, 4), typed('error', { error: { type: 'overloaded_error', message: 'Overloaded' } })], hdr)
      lines.push(typed('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: { input_tokens: input, cache_creation_input_tokens: write, cache_read_input_tokens: read, output_tokens: output, server_tool_use: { web_search_requests: 0 } } }))
      lines.push(typed('message_stop', {}))
      return sse(lines, hdr)
    }
    if (url.pathname === '/v1/responses') {
      const turn = nextTurn({ format: 'openai-responses', body, session: sessionOf(request.headers, body), ...responsesCtx(body) })
      if (turn.fail) return json(turn.fail, { error: { message: `fake error ${turn.fail}`, type: turn.fail === 429 ? 'rate_limit_exceeded' : 'server_error', param: null, code: null } }, turn.fail === 429 ? { 'retry-after': '1' } : {})
      const input = Math.max(1, wordsIn(body.input) + wordsIn(body.instructions))
      const cached = Math.floor(input / 2)
      const id = `resp_${newId('r').replace(/-/g, '')}`
      const base = { id, object: 'response', created_at: created, status: 'in_progress', background: false, error: null, incomplete_details: null, instructions: null, max_output_tokens: null, model, output: [], parallel_tool_calls: body.parallel_tool_calls ?? true, previous_response_id: null, reasoning: { effort: null, summary: null }, store: body.store ?? true, temperature: 1, text: { format: { type: 'text' } }, tool_choice: body.tool_choice ?? 'auto', tools: [], top_p: 1, truncation: 'disabled', usage: null, user: null, metadata: {} }
      const items = []
      if (turn.thinking) items.push({ id: `rs_${newId('i').replace(/-/g, '')}`, type: 'reasoning', summary: [{ type: 'summary_text', text: turn.thinking }], encrypted_content: sigOf(turn.thinking) })
      if (turn.text) items.push({ id: `msg_${newId('i').replace(/-/g, '')}`, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', annotations: [], logprobs: [], text: turn.text }] })
      if (turn.tool) items.push({ id: `fc_${newId('i').replace(/-/g, '')}`, type: 'function_call', status: 'completed', arguments: JSON.stringify(turn.tool.input ?? {}), call_id: `call_${newId('c').replace(/-/g, '')}`, name: turn.tool.name })
      const reasoning = turn.thinking ? words(turn.thinking).length : 0
      const output = Math.max(1, reasoning + (turn.text ? words(turn.text).length : 0) + (turn.tool ? wordsIn(turn.tool.input) + 1 : 0))
      const usage = { input_tokens: input, input_tokens_details: { cached_tokens: cached }, output_tokens: output, output_tokens_details: { reasoning_tokens: reasoning }, total_tokens: input + output }
      const done = { ...base, status: 'completed', output: items, usage }
      if (!body.stream) return json(200, done)
      let n = 0
      const ev = (type, o) => typed(type, { sequence_number: n++, ...o })
      const lines = [ev('response.created', { response: base }), ev('response.in_progress', { response: base })]
      items.forEach((it, output_index) => {
        if (it.type === 'reasoning') {
          const text = it.summary[0].text
          lines.push(ev('response.output_item.added', { output_index, item: { id: it.id, type: 'reasoning', summary: [] } }))
          lines.push(ev('response.reasoning_summary_part.added', { item_id: it.id, output_index, summary_index: 0, part: { type: 'summary_text', text: '' } }))
          for (const p of pieces(text)) lines.push(ev('response.reasoning_summary_text.delta', { item_id: it.id, output_index, summary_index: 0, delta: p }))
          lines.push(ev('response.reasoning_summary_text.done', { item_id: it.id, output_index, summary_index: 0, text }))
          lines.push(ev('response.reasoning_summary_part.done', { item_id: it.id, output_index, summary_index: 0, part: { type: 'summary_text', text } }))
        } else if (it.type === 'message') {
          const text = it.content[0].text
          lines.push(ev('response.output_item.added', { output_index, item: { id: it.id, type: 'message', status: 'in_progress', role: 'assistant', content: [] } }))
          lines.push(ev('response.content_part.added', { item_id: it.id, output_index, content_index: 0, part: { type: 'output_text', annotations: [], logprobs: [], text: '' } }))
          words(text).forEach((w, i) => lines.push(ev('response.output_text.delta', { item_id: it.id, output_index, content_index: 0, delta: (i ? ' ' : '') + w, logprobs: [] })))
          lines.push(ev('response.output_text.done', { item_id: it.id, output_index, content_index: 0, text, logprobs: [] }))
          lines.push(ev('response.content_part.done', { item_id: it.id, output_index, content_index: 0, part: { type: 'output_text', annotations: [], logprobs: [], text } }))
        } else {
          lines.push(ev('response.output_item.added', { output_index, item: { ...it, status: 'in_progress', arguments: '' } }))
          for (const p of jsonPieces(it.arguments)) lines.push(ev('response.function_call_arguments.delta', { item_id: it.id, output_index, delta: p }))
          lines.push(ev('response.function_call_arguments.done', { item_id: it.id, output_index, arguments: it.arguments }))
        }
        lines.push(ev('response.output_item.done', { output_index, item: it }))
      })
      // Cut short: the connection closes before response.completed. / 中途断开：response.completed 之前连接关闭。
      if (turn.cut) return sse(lines.slice(0, 5))
      lines.push(ev('response.completed', { response: done }))
      return sse(lines)
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
    if (!r.body || req.method === 'HEAD') return res.end()
    for await (const c of r.body) res.write(c)
    res.end()
  })
  await new Promise((resolve, reject) => server.once('error', reject).listen(port, host, resolve))
  return { baseUrl: `http://${host}:${server.address().port}/v1`, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()) }) }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { baseUrl } = await startFakeUpstream({ port: Number(process.env.PORT || 8799), host: process.env.HOST || '127.0.0.1' })
  console.log(`[fake-ai] fake AI API (OpenAI Chat, OpenAI Responses, Anthropic Messages) on ${baseUrl}; key ${DEMO_KEY}; models ${MODELS.join(', ')}`)
}
