// AI format adapter: OpenAI Chat Completions (POST /v1/chat/completions). See ai.js for the adapter interface.
// Stream: server-sent events, one JSON chunk per `data:` line, ended by `data: [DONE]` (the final event: the receipt goes
// right before it, and it is left out of the hash). Usage arrives in a last chunk with `choices: []` (LiteLLM: choices
// with an empty delta), but only when the request set stream_options.include_usage; the sidecar therefore always asks the upstream for it and, when the client
// did not, strips that one chunk from what the client receives (prepareUpstream / isInjectedEvent).
// Complete: some choice reached a finish_reason and no chunk carried an `error`.
// 完整：某个 choice 有了 finish_reason，且没有带 error 的块。
// AI 格式适配器：OpenAI Chat Completions。流：SSE，每个 data 行一个 JSON 块，以 `data: [DONE]` 结束（最终事件：回执放在它
// 之前，它不计入哈希）。usage 在最后一个 choices 为空的块里，但只有请求设了 stream_options.include_usage 才有；所以旁路总是
// 向上游要 usage，客户端没要时从它收到的内容里去掉这一块。
//
// No imports: an adapter is pure data and small functions. / 不引用任何模块：适配器只是数据与小函数。

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
const str = (v) => (typeof v === 'string' ? v : null)
const num = (v) => (typeof v === 'number' ? v : undefined)
const EMPTY_CHOICE_KEYS = new Set(['index', 'delta', 'finish_reason', 'logprobs'])
const carriesNothing = (c) => isObj(c) && isObj(c.delta) && Object.values(c.delta).every((v) => v === null)
  && (c.finish_reason ?? null) === null && (c.logprobs ?? null) === null && Object.keys(c).every((k) => EMPTY_CHOICE_KEYS.has(k))

// OpenAI counts -> the receipt's buckets: prompt_tokens already includes the cached tokens and completion_tokens the
// reasoning tokens (both are subsets), which is the receipt's convention too. DeepSeek reports cache hits its own way.
// OpenAI 计数 -> 回执分桶：prompt_tokens 已包含缓存命中部分，completion_tokens 已包含推理部分（都是子集），与回执约定一致。
function openaiUsage(u) {
  if (!isObj(u)) return null
  return {
    prompt_tokens: u.prompt_tokens, completion_tokens: u.completion_tokens, total_tokens: u.total_tokens,
    cache_read_tokens: num(u.prompt_tokens_details?.cached_tokens) ?? num(u.prompt_cache_hit_tokens),
    reasoning_tokens: num(u.completion_tokens_details?.reasoning_tokens),
  }
}
const OPENAI_HEADERS = Object.freeze(['authorization', 'openai-beta', 'openai-organization', 'openai-project'])
const OPENAI_EXPOSE = Object.freeze(['x-request-id', 'openai-processing-ms', 'openai-version', 'retry-after-ms', 'x-should-retry'])

export const openaiChat = Object.freeze({
  name: 'openai-chat',
  method: 'openai_chat',
  baseSuffix: '/v1',
  match: ({ verb, path }) => verb === 'POST' && path === '/v1/chat/completions',
  headers: OPENAI_HEADERS,
  exposeHeaders: OPENAI_EXPOSE,
  requestModel: (body) => (isObj(body) ? str(body.model) : null),
  stream: Object.freeze({ framing: 'sse', sentinel: '[DONE]', final: Object.freeze({ data: Object.freeze(['[DONE]']) }) }),
  // A streamed request that did not ask for usage: ask the upstream for it, and strip the chunk it adds.
  // 没要 usage 的流式请求：替它向上游要，并去掉上游因此多发的那一块。
  prepareUpstream(body) {
    if (!isObj(body) || body.stream !== true) return null
    const so = isObj(body.stream_options) ? body.stream_options : {}
    if (so.include_usage === true) return null
    return { body: { ...body, stream_options: { ...so, include_usage: true } }, strip: true }
  },
  // The chunk the added include_usage causes: a usage object and choices that carry nothing -- `[]` (OpenAI), or entries
  // with an empty delta and nothing else (LiteLLM: `[{ index: 0, delta: {} }]`, FIXED P101-b). A choice with any content,
  // a finish_reason, logprobs or any other member makes it a real chunk, never taken out.
  // 加上 include_usage 所引起的块：有 usage 对象、choices 里什么都没有——`[]`（OpenAI），或只有空 delta 的条目（LiteLLM：
  // `[{ index: 0, delta: {} }]`，FIXED P101-b）。choice 里有任何内容、finish_reason、logprobs 或其它成员，就是真实的块，绝不去掉。
  isInjectedEvent: (json) => isObj(json) && isObj(json.usage) && Array.isArray(json.choices) && json.choices.every(carriesNothing),
  response: (json) => (isObj(json) ? { id: str(json.id), model: str(json.model), usage: openaiUsage(json.usage) } : { id: null, model: null, usage: null }),
  streamState() {
    const s = { id: null, model: null, usage: null }
    let finished = false, error = false
    return {
      event(json) {
        if (!isObj(json)) return
        if (json.error !== undefined && json.error !== null) error = true
        if (Array.isArray(json.choices) && json.choices.some((c) => isObj(c) && c.finish_reason !== null && c.finish_reason !== undefined)) finished = true
        if (s.id === null && typeof json.id === 'string') s.id = json.id   // every chunk repeats it; the first counts / 每块都带；以第一个为准
        if (typeof json.model === 'string') s.model = json.model
        if (isObj(json.usage)) s.usage = openaiUsage(json.usage)
      },
      result: () => ({ ...s, complete: finished && !error }),
    }
  },
})
