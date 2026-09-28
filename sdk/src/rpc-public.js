// @tapeapi/sdk/rpc: the public face of the quorum JSON-RPC client (review G1 M13). rpc.js also exports the helpers the
// SDK uses internally (readJsonBounded, describeUrl, isNodeLimit); they are not part of the public API.
// @tapeapi/sdk/rpc：法定数 JSON-RPC 客户端的公开接口。rpc.js 另外导出的内部辅助函数不属于公开接口。
export { createRpc, RPC_BODY_LIMIT } from './rpc.js'
