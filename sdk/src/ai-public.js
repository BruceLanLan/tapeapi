// @tapeapi/sdk/ai and the root `ai` namespace: the public face of the AI usage-receipt module (review RC-7). ai.js also
// exports what the SDK's own tools and tests use (the limits, the rest of the price arithmetic, the salt, the SSE digest
// of payloads); those are not part of the API. Since 2.5 five price helpers are public again, marked @experimental (2.5)
// in types/ai.d.ts and below: amountOf, pricesOf, maxAmountOf, maxPricesOf, completionLimitOf (outside the
// compatibility promise). Of the names below, the ones marked @internal in types/ai.d.ts are here only because the
// reference sidecar (@tapeapi/server) and the website reach them through the package root.
// @tapeapi/sdk/ai 与根命名空间 ai：AI 用量回执模块的公开接口。ai.js 另外导出的、只供 SDK 自己的工具与测试使用的名字（上限、其余的
// 价格计算、盐、SSE 载荷摘要）不属于公开接口。2.5 起有五个价格辅助函数重新公开，在 types/ai.d.ts 与下面标为实验性（2.5）：
// amountOf、pricesOf、maxAmountOf、maxPricesOf、completionLimitOf（不在兼容承诺之内）。下面在 types/ai.d.ts 里标 @internal 的，
// 只因参考旁路与网站经由包的根入口使用它们才保留在这里。
export {
  // Stable / 稳定
  FORMATS, MANIFEST_FIELD, RECEIPT_HEADER, RECEIPT_METHOD, SIDECAR_ERROR_HEADER, VERIFY_ERROR_HEADER,
  createVerifyingFetch, verifyUsageReceipt, validateAIField, decodeReceiptHeader, readSseReceipt, scanSse, usageOf,
  formatFor, sha256Hex,
  // @experimental (2.5): price arithmetic for a billing layer in front of a sidecar (the receipt's own amountOf, and a
  // worst-case bound for holding funds before forwarding) / 实验性：给旁路前面的计费层用的价格计算
  amountOf, pricesOf, maxAmountOf, maxPricesOf, completionLimitOf,
  // @experimental (3.0, a proposal, not part of TAPI-21 or of any TAP; see the CHANGELOG): a stable reference to one receipt,
  // and the price basis a sidecar created with priceRef: true signs into it / 实验性（提案，非规范）：回执引用与价格依据
  receiptRef, priceRefOf,
  // @internal: the reference sidecar and the website / 参考旁路与网站使用
  FORWARD_HEADERS, MODEL_ID_MAX, SESSION_HEADERS, apiPath, completeOf, createSseScanner, encodeReceipt, envelopeProblems,
  formatOfMethod, forwardsHeader, isAnswerId, isSessionHeader, modelEntryOf, priceProblems, pricingOf, receiptComment,
  // @internal (1.6): the reference sidecar sets the usage member in the request's bytes / 参考旁路按字节设置用量成员
  requestUsageBody,
} from './ai.js'
// @experimental (3.0): the client-side budget createVerifyingFetch({ policy }) uses, for sharing one between fetches or
// with the agent kit's limiter, and its stores (a file: mode 600). / 实验性：客户端预算及其存储（文件权限 600）。
export { createBudget, budgetFileStore, memoryBudgetStore } from './ai.js'
