// Type declarations for @tapeapi/sdk/mcp (hand-written; ../src/mcp.js is the source of truth).

export declare const MCP_PROTOCOL_VERSIONS: readonly string[]
export declare const RECEIPT_META_KEY: 'fun.tapeapi/receipt'
export declare const VERIFY_BASE: string
export declare const JSONRPC: Readonly<{ PARSE: -32700; INVALID_REQUEST: -32600; METHOD_NOT_FOUND: -32601; INVALID_PARAMS: -32602; INTERNAL: -32603 }>

export interface McpTool {
  name: string
  title?: string
  description: string
  inputSchema: Record<string, unknown>
  annotations?: Record<string, unknown>
  paid?: boolean
  [key: string]: unknown
}
export interface McpContent { type: 'text'; text: string }
export interface CallToolResult {
  content: McpContent[]
  structuredContent?: Record<string, unknown>
  isError: boolean
  _meta?: Record<string, unknown>
}
export interface McpServer {
  /** One JSON-RPC message in; the response, or null for a notification. */
  handle(message: unknown): Promise<Record<string, unknown> | null>
}
export declare function createMcpServer(o: {
  info: { name: string; version: string; title?: string }
  instructions?: string
  listTools(): Promise<McpTool[]>
  callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult>
}): McpServer

/** Everything needed to verify a signed answer again later. */
export interface Receipt {
  v: 1
  service: { circuits: string; tokenId: string; container: string; name?: string }
  method: string
  params: unknown
  id: string
  ts: number
  ok: boolean
  result?: unknown
  error?: { code: string; message?: string; data?: unknown }
  block?: number
  sig: string
}
export declare function receiptOf(o: { envelope: Record<string, any>; method: string; params: unknown; circuits: string; tokenId: string | number; name?: string }): Receipt
export declare function toBase64Url(text: string): string
export declare function fromBase64Url(s: string): string
export declare function verifyLink(receipt: Receipt, base?: string): string
export declare function toolResultOf(o: { receipt: Receipt; checkedBy: 'client' | 'service'; signer?: string; link?: string }): CallToolResult
