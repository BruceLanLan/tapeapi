// Type declarations for @tapeapi/server/openai-proxy (hand-written; ../src/openai-proxy.js is the source of truth):
// the AI sidecar under the name PLAN-2026Q4 A3 uses. / PLAN-2026Q4 A3 所用名称下的 AI 旁路。
export { createAIProxy, createAIProxy as createOpenAIProxy, REQUEST_LIMIT, RESPONSE_LIMIT, UPSTREAM_TIMEOUT_MS, RECEIPT_TTL_MS, MAX_RECEIPTS, HOLD_LIMIT } from './ai-proxy.js'
export type { AIProxy, AIProxyStats, AIProxyManifestBase } from './ai-proxy.js'
