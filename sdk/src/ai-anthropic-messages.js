// AI format adapter: Anthropic Messages (POST /v1/messages; /v1/messages/count_tokens is free and passes through). See
// ai.js for the adapter interface. The base URL a client configures has no /v1 (the SDKs add it).
// Stream: `event: message_start` (id, model, usage so far), content blocks, `message_delta` (usage, cumulative),
// `message_stop` (the final event: the receipt goes right before it), and `event: ping` at any time (passed through).
// Usage: input_tokens EXCLUDES cache reads and writes, which are reported apart; the receipt's prompt_tokens is their
// sum, so every format bills the same buckets. cache_creation.ephemeral_1h_input_tokens (the 1-hour cache writes) is
// the receipt's cache_write_1h_tokens, a subset of the cache writes.
// Complete: the stream reached message_stop and carried no `error` event.
// 完整：流到达 message_stop 且没有 error 事件。1 小时缓存写入（ephemeral_1h_input_tokens）记为 cache_write_1h_tokens。
// AI 格式适配器：Anthropic Messages（count_tokens 免费、透传）。客户端配置的 base URL 不带 /v1。流：message_start、内容块、
// message_delta（usage 为累计值）、message_stop（最终事件：回执放在它之前），ping 随时出现（原样转发）。usage：input_tokens
// 不含缓存读写（另报）；回执的 prompt_tokens 是三者之和，所有格式按同样的分桶计费。
//
// No imports: an adapter is pure data and small functions. / 不引用任何模块：适配器只是数据与小函数。

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
const str = (v) => (typeof v === 'string' ? v : null)
const count = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : undefined)

function usage(u) {
  if (!isObj(u) || count(u.input_tokens) === undefined) return null
  const read = count(u.cache_read_input_tokens), write = count(u.cache_creation_input_tokens)
  const prompt = u.input_tokens + (read ?? 0) + (write ?? 0)
  const write1h = count(u.cache_creation?.ephemeral_1h_input_tokens)
  const out = { prompt_tokens: prompt, completion_tokens: u.output_tokens, total_tokens: count(u.output_tokens) === undefined ? undefined : prompt + u.output_tokens, cache_read_tokens: read, cache_write_tokens: write, cache_write_1h_tokens: write1h }
  // Server tools are billed per use, not per token: reported, priced by no token price. / 服务端工具按次计费，不按 token。
  const searches = count(u.server_tool_use?.web_search_requests)
  if (searches) out.other = { web_search_requests: searches }
  return out
}

export const anthropicMessages = Object.freeze({
  name: 'anthropic-messages',
  method: 'anthropic_messages',
  baseSuffix: '',
  match: ({ verb, path }) => verb === 'POST' && path === '/v1/messages',
  // Passed verbatim, whatever their values (anthropic-beta lists change often). / 原样转发，不管取值。
  headers: Object.freeze(['x-api-key', 'authorization', 'anthropic-version', 'anthropic-beta']),
  exposeHeaders: Object.freeze(['request-id', 'anthropic-organization-id', 'x-should-retry']),
  requestModel: (body) => (isObj(body) ? str(body.model) : null),
  stream: Object.freeze({ framing: 'sse', sentinel: null, final: Object.freeze({ event: Object.freeze(['message_stop']) }) }),
  response: (json) => (isObj(json) ? { id: str(json.id), model: str(json.model), usage: usage(json.usage), complete: json.type === 'error' ? false : undefined } : { id: null, model: null, usage: null }),
  streamState() {
    const s = { id: null, model: null, raw: null, stop: false, error: false }
    return {
      event(json, name) {
        if (!isObj(json)) return
        const type = typeof json.type === 'string' ? json.type : name
        if (type === 'message_stop') s.stop = true
        else if (type === 'error') s.error = true
        if (type === 'message_start' && isObj(json.message)) {
          const m = json.message
          if (typeof m.id === 'string') s.id = m.id
          if (typeof m.model === 'string') s.model = m.model
          if (isObj(m.usage)) s.raw = { ...m.usage }
        } else if (type === 'message_delta' && isObj(json.usage)) {
          // Cumulative: the latest value of each field wins, message_start fills the rest. / 累计值：各字段取最新，缺的用 message_start 的。
          s.raw = { ...(s.raw || {}), ...Object.fromEntries(Object.entries(json.usage).filter(([, v]) => v !== null && v !== undefined)) }
        }
      },
      result: () => ({ id: s.id, model: s.model, usage: usage(s.raw), complete: s.stop && !s.error }),
    }
  },
})
