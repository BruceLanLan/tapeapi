// AI format adapter: OpenAI Responses (POST /v1/responses, and POST /v1/responses/compact, the conversation compaction
// Codex calls, which is billed like a response and signed as one, never streamed in practice). See ai.js for the adapter
// interface. Complete: response.completed (a whole answer: status "completed", or no status); response.failed,
// response.incomplete, an `error` event or a stream without a final event are not complete.
// 也计量 /v1/responses/compact（Codex 的会话压缩，按回答计费、按回答签名）。完整：response.completed；failed、incomplete、
// error 事件或没有最终事件都不算完整。
// Stream: typed server-sent events (`event: response.created`, `response.output_text.delta`, ...), each with a JSON
// `data` whose `type` repeats the event name. The final event is `response.completed`, `response.incomplete` or
// `response.failed`, and it carries the whole response with its usage: the receipt goes right before it. A trailing
// `data: [DONE]`, which some servers add, is optional and left out of the hash. A stream sent without `event:` lines
// cannot be recognised at its first line; its receipt is appended at the end instead.
// AI 格式适配器：OpenAI Responses。流：带类型的 SSE，data 里的 type 与事件名相同。最终事件是 response.completed、
// response.incomplete 或 response.failed，带着整个回应及其 usage：回执放在它之前。有的服务器末尾还加 `data: [DONE]`，可有可无，
// 不计入哈希。不带 `event:` 行的流无法在第一行认出最终事件，回执改为追加在末尾。
//
// No imports: an adapter is pure data and small functions. / 不引用任何模块：适配器只是数据与小函数。

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
const str = (v) => (typeof v === 'string' ? v : null)
const num = (v) => (typeof v === 'number' ? v : undefined)
const HEADERS = Object.freeze(['authorization', 'openai-beta', 'openai-organization', 'openai-project'])
const EXPOSE = Object.freeze(['x-request-id', 'openai-processing-ms', 'openai-version', 'retry-after-ms', 'x-should-retry'])

// input_tokens includes the cached ones and output_tokens the reasoning ones (subsets), as in the receipt.
// input_tokens 包含缓存命中部分，output_tokens 包含推理部分（子集），与回执约定一致。
function usage(u) {
  if (!isObj(u)) return null
  return {
    prompt_tokens: u.input_tokens, completion_tokens: u.output_tokens, total_tokens: u.total_tokens,
    cache_read_tokens: num(u.input_tokens_details?.cached_tokens), reasoning_tokens: num(u.output_tokens_details?.reasoning_tokens),
  }
}

export const openaiResponses = Object.freeze({
  name: 'openai-responses',
  method: 'openai_responses',
  baseSuffix: '/v1',
  match: ({ verb, path }) => verb === 'POST' && (path === '/v1/responses' || path === '/v1/responses/compact'),
  headers: HEADERS,
  exposeHeaders: EXPOSE,
  requestModel: (body) => (isObj(body) ? str(body.model) : null),
  stream: Object.freeze({ framing: 'sse', sentinel: '[DONE]', final: Object.freeze({ event: Object.freeze(['response.completed', 'response.incomplete', 'response.failed']) }) }),
  response: (json) => (isObj(json) ? { id: str(json.id), model: str(json.model), usage: usage(json.usage), complete: typeof json.status === 'string' ? json.status === 'completed' : undefined } : { id: null, model: null, usage: null }),
  streamState() {
    const s = { id: null, model: null, usage: null }
    let done = false, bad = false
    return {
      event(json, name) {
        const type = isObj(json) && typeof json.type === 'string' ? json.type : name
        if (type === 'response.completed') done = true
        else if (type === 'response.failed' || type === 'response.incomplete' || type === 'error') bad = true
        const r = isObj(json) ? json.response : null
        if (!isObj(r)) return
        if (s.id === null && typeof r.id === 'string') s.id = r.id
        if (typeof r.model === 'string') s.model = r.model
        if (isObj(r.usage)) s.usage = usage(r.usage)
      },
      result: () => ({ ...s, complete: done && !bad }),
    }
  },
})
