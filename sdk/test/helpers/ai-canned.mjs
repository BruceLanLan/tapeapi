// A canned AI upstream for tests that record bytes: fixed answers per path, nothing time- or random-dependent. OpenAI
// Chat streams carry the usage chunk (`choices: []`) only when the request set stream_options.include_usage to true, as
// OpenAI does; every other answer always carries its usage. Each request's body bytes are kept in `seen`.
// 供录制字节的测试使用的固定 AI 上游：每个路径一个固定回答，与时间和随机无关。OpenAI Chat 的流只有请求把
// stream_options.include_usage 设为 true 时才带用量块（choices: []），与 OpenAI 相同；其它回答总带用量。每个请求的正文字节记在 seen。
import { createAIProxy } from '../../../server/src/ai-proxy.js'
import { createTapeAPI } from '../../src/index.js'

export const KEY = '0x' + '42'.repeat(32)
export const MODELS = [
  { id: 'demo-chat', formats: ['openai-chat', 'openai-responses'], prices: [{ currency: 'BEM', unit: '1M tokens', input: '0.15', output: '0.6' }] },
  { id: 'demo-claude', formats: ['anthropic-messages'], prices: [{ currency: 'BEM', unit: '1M tokens', input: '3', output: '15' }] },
  { id: 'demo-embed', formats: ['openai-embeddings'], prices: [{ currency: 'BEM', unit: '1M tokens', input: '0.02', output: '0' }] },
]
export const CREATED = 1_790_000_000
const sse = (o, name) => `${name ? `event: ${name}\n` : ''}data: ${JSON.stringify(o)}\n\n`
export const CHAT_USAGE = { prompt_tokens: 9, completion_tokens: 3, total_tokens: 12 }
const chunk = (o) => sse({ id: 'chatcmpl-base1', object: 'chat.completion.chunk', created: CREATED, model: 'demo-chat', ...o })
/** The Chat stream, with or without its usage chunk. / Chat 的流，带或不带用量块。 */
export function chatStream(withUsage) {
  return chunk({ choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] }) +
    chunk({ choices: [{ index: 0, delta: { content: 'Hello' }, finish_reason: null }] }) +
    chunk({ choices: [{ index: 0, delta: { content: ' there' }, finish_reason: null }] }) +
    chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) +
    (withUsage ? chunk({ choices: [], usage: CHAT_USAGE }) : '') +
    'data: [DONE]\n\n'
}
export const CHAT_JSON = JSON.stringify({ id: 'chatcmpl-base2', object: 'chat.completion', created: CREATED, model: 'demo-chat', choices: [{ index: 0, message: { role: 'assistant', content: 'Hello there' }, finish_reason: 'stop' }], usage: CHAT_USAGE })
const RESP_USAGE = { input_tokens: 8, output_tokens: 2, total_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } }
const respObj = (status, usage, text) => ({ id: 'resp_base1', object: 'response', created_at: CREATED, status, model: 'demo-chat', output: text ? [{ type: 'message', id: 'msg_r1', role: 'assistant', content: [{ type: 'output_text', text }] }] : [], usage })
export const RESPONSES_STREAM = sse({ type: 'response.created', response: respObj('in_progress', null, null) }, 'response.created') +
  sse({ type: 'response.output_text.delta', delta: 'Hi' }, 'response.output_text.delta') +
  sse({ type: 'response.completed', response: respObj('completed', RESP_USAGE, 'Hi') }, 'response.completed')
export const RESPONSES_JSON = JSON.stringify(respObj('completed', RESP_USAGE, 'Hi'))
export const ANTHROPIC_STREAM = sse({ type: 'message_start', message: { id: 'msg_base1', type: 'message', role: 'assistant', model: 'demo-claude', content: [], stop_reason: null, usage: { input_tokens: 11, output_tokens: 1 } } }, 'message_start') +
  sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, 'content_block_start') +
  sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hey' } }, 'content_block_delta') +
  sse({ type: 'content_block_stop', index: 0 }, 'content_block_stop') +
  sse({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } }, 'message_delta') +
  sse({ type: 'message_stop' }, 'message_stop')
export const ANTHROPIC_JSON = JSON.stringify({ id: 'msg_base2', type: 'message', role: 'assistant', model: 'demo-claude', content: [{ type: 'text', text: 'Hey' }], stop_reason: 'end_turn', usage: { input_tokens: 11, output_tokens: 4 } })
export const EMBEDDINGS_JSON = JSON.stringify({ object: 'list', data: [{ object: 'embedding', index: 0, embedding: [0.25, -0.5] }], model: 'demo-embed', usage: { prompt_tokens: 3, total_tokens: 3 } })

const bodyJson = (b) => { try { return JSON.parse(new TextDecoder().decode(b)) } catch { return null } }
/**
 * The canned upstream as a fetch: (url, init) -> Response. `seen` collects { url, body: Uint8Array }.
 * 固定上游的 fetch 形式；seen 记下每个请求。
 */
export function cannedUpstream() {
  const seen = []
  const ev = (s) => new Response(s, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  const js = (s) => new Response(s, { status: 200, headers: { 'content-type': 'application/json' } })
  async function fetch(url, init = {}) {
    const raw = init.body == null ? new Uint8Array(0) : new Uint8Array(await new Response(init.body).arrayBuffer())
    seen.push({ url: String(url), body: raw })
    const path = new URL(url).pathname
    const j = bodyJson(raw) ?? {}
    const stream = j && j.stream === true
    if (path.endsWith('/chat/completions')) return stream ? ev(chatStream(j.stream_options?.include_usage === true)) : js(CHAT_JSON)
    if (path.endsWith('/responses')) return stream ? ev(RESPONSES_STREAM) : js(RESPONSES_JSON)
    if (path.endsWith('/messages')) return stream ? ev(ANTHROPIC_STREAM) : js(ANTHROPIC_JSON)
    if (path.endsWith('/embeddings')) return js(EMBEDDINGS_JSON)
    return new Response('{"error":{"message":"not found"}}', { status: 404, headers: { 'content-type': 'application/json' } })
  }
  return { fetch, seen }
}

export const BASE = 'http://127.0.0.1:8797'
export const manifestBase = (live = `${BASE}/tapeapi/v1`) => ({ name: 'Canned', circuits: '0x0000000000000000000000000000000000000000', tokenId: '0', container: '0x0000000000000000000000000000000000000000', delegation: null, dev: true, endpoints: { live: [live], async: false } })

/**
 * The reference sidecar over the canned upstream, and a resolved service for createVerifyingFetch. `live` is the
 * service root's tapeapi URL (another host for a sidecar behind an HTTP server). / 固定上游前的参考旁路，以及解析好的服务。
 */
export async function cannedWorld({ live, formats } = {}) {
  const up = cannedUpstream()
  const proxy = createAIProxy({ upstream: { baseUrl: 'http://upstream.local/v1' }, fetch: up.fetch, manifestBase: manifestBase(live), signerKey: KEY, models: MODELS, allowHttp: true, rateLimit: false, log: () => {}, ...(formats ? { formats } : {}) })
  await proxy.ready
  const api = createTapeAPI({ dev: true, fetch: (u, i) => proxy.handleRequest(new Request(u, i)) })
  const service = live ? null : await api.resolve({ dev: BASE })
  return { up, proxy, api, service }
}

/** Bytes as text when they are UTF-8, else "base64:..." (a fixture stays readable). / 字节为 UTF-8 时显示为文本，否则 base64。 */
export function show(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(b) } catch { return 'base64:' + Buffer.from(b).toString('base64') }
}
