// AI format adapter: OpenAI Embeddings (POST /v1/embeddings). Never streamed; the answer carries no id and no
// completion tokens (the core generates an id and counts completion_tokens as 0). See ai.js for the adapter interface.
// AI 格式适配器：OpenAI Embeddings。从不流式；回答没有 id，也没有 completion token（核心会生成 id，completion_tokens 记为 0）。
//
// No imports: an adapter is pure data and small functions. / 不引用任何模块：适配器只是数据与小函数。

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v)

export const openaiEmbeddings = Object.freeze({
  name: 'openai-embeddings',
  method: 'openai_embeddings',
  baseSuffix: '/v1',
  match: ({ verb, path }) => verb === 'POST' && path === '/v1/embeddings',
  headers: Object.freeze(['authorization', 'openai-beta', 'openai-organization', 'openai-project']),
  exposeHeaders: Object.freeze(['x-request-id', 'openai-processing-ms', 'openai-version', 'retry-after-ms', 'x-should-retry']),
  requestModel: (body) => (isObj(body) && typeof body.model === 'string' ? body.model : null),
  // null: an answer is always signed whole, as bytes, even if an upstream sent it as an event stream.
  // null：回答总是作为整体字节签名，即使上游以事件流发送。
  stream: null,
  response: (json) => (isObj(json)
    ? { id: typeof json.id === 'string' ? json.id : null, model: typeof json.model === 'string' ? json.model : null, usage: isObj(json.usage) ? { prompt_tokens: json.usage.prompt_tokens, total_tokens: json.usage.total_tokens } : null }
    : { id: null, model: null, usage: null }),
  streamState: () => ({ event() {}, result: () => ({ id: null, model: null, usage: null, complete: false }) }),
})
