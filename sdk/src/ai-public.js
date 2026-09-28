// @tapeapi/sdk/ai and the root `ai` namespace: the public face of the AI usage-receipt module (review RC-7). ai.js also
// exports what the SDK's own tools and tests use (the limits, the price arithmetic, the salt, the SSE digest of payloads);
// those are not part of the API. Of the names below, the ones marked @internal in types/ai.d.ts are here only because the
// reference sidecar (@tapeapi/server) and the website reach them through the package root.
// @tapeapi/sdk/ai 与根命名空间 ai：AI 用量回执模块的公开接口。ai.js 另外导出的、只供 SDK 自己的工具与测试使用的名字不属于公开接口；
// 下面在 types/ai.d.ts 里标 @internal 的，只因参考旁路与网站经由包的根入口使用它们才保留在这里。
export {
  // Stable / 稳定
  FORMATS, MANIFEST_FIELD, RECEIPT_HEADER, RECEIPT_METHOD, SIDECAR_ERROR_HEADER, VERIFY_ERROR_HEADER,
  createVerifyingFetch, verifyUsageReceipt, validateAIField, decodeReceiptHeader, readSseReceipt, scanSse, usageOf,
  formatFor, sha256Hex,
  // @internal: the reference sidecar and the website / 参考旁路与网站使用
  FORWARD_HEADERS, MODEL_ID_MAX, SESSION_HEADERS, apiPath, completeOf, createSseScanner, encodeReceipt, envelopeProblems,
  formatOfMethod, forwardsHeader, isAnswerId, isSessionHeader, modelEntryOf, priceProblems, pricingOf, receiptComment,
} from './ai.js'
