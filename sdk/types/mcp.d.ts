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
/** The hash-only form of a receipt: params and result replaced by the two hashes the signature covers. */
export interface HashedReceipt {
  v: 2
  service: { circuits: string; tokenId: string; container: string; name?: string }
  /** As stated; bound only through requestHash, which covers method and params together. */
  method: string
  /** keccak256(canonicalJSON({ method, params })), 0x hex */
  requestHash: string
  id: string
  ts: number
  ok: boolean
  /** keccak256(canonicalJSON(result or error)), 0x hex */
  bodyHash: string
  block?: number
  sig: string
}
/** The hash-only form (a v 2 receipt is returned as it is). Params from a small set can still be guessed from requestHash. */
export declare function hashReceipt(receipt: Receipt | HashedReceipt): HashedReceipt
/** A verify-page link; the hash-only form unless { content: true } (then params and result are in the link, in clear). */
export declare function verifyLink(receipt: Receipt | HashedReceipt, base?: string, o?: { content?: boolean }): string
export declare function toolResultOf(o: { receipt: Receipt; checkedBy: 'client' | 'service'; signer?: string; linkContent?: boolean; link?: string }): CallToolResult

/** The MCP tool fields that are hashed. */
export declare const TOOL_DIGEST_FIELDS: readonly string[]
/** Those fields only, sorted by name. */
export declare function normalizeTools(tools: McpTool[]): Record<string, unknown>[]
/** sha256 hex of the canonical JSON of normalizeTools(tools). */
export declare function toolsDigest(tools: McpTool[]): string
/**
 * Invisible or format code points (Unicode Cf; C0/C1 controls except \n and \t in a description) in any string of the
 * digest-covered fields, keys included: one "tool X: field path: U+XXXX" line per offending string, [] when none.
 */
export declare function invisibleProblems(tools: unknown): string[]

/** Text that looks like TapeAPI's provenance line or links to its verify page (no g flag). */
export declare const PROVENANCE_RE: RegExp
/** Prefixed to upstream text items that match PROVENANCE_RE. */
export declare const QUOTED_PREFIX: string
/** Upstream content with every PROVENANCE_RE match labelled as the tool's own output and its "Signed by" phrase neutralised. */
export declare function quoteProvenance<T extends { type: string; text?: string }>(content: T[]): T[]
