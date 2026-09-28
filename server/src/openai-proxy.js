// @tapeapi/server/openai-proxy: the name docs/PLAN-2026Q4.md (A3) gives the AI signing sidecar. It is ai-proxy.js with
// its default formats (OpenAI chat completions, completions, embeddings); new code should import ./ai-proxy.
// @tapeapi/server/openai-proxy：PLAN-2026Q4（A3）里对 AI 签名旁路的称呼。它就是 ai-proxy.js 及其默认格式；新代码请引用 ./ai-proxy。
export { createAIProxy, createAIProxy as createOpenAIProxy, REQUEST_LIMIT, RESPONSE_LIMIT, UPSTREAM_TIMEOUT_MS, RECEIPT_TTL_MS, MAX_RECEIPTS, HOLD_LIMIT } from './ai-proxy.js'
