// Type declarations for @tapeapi/server/mcp (hand-written; ../src/mcp.js is the source of truth).
import type { Manifest } from '@tapeapi/sdk'
import type { McpTool } from '@tapeapi/sdk/mcp'

export declare const MCP_PATH: '/mcp'
/** A provider as a remote MCP server (Streamable HTTP, stateless). */
export declare function createMcpEndpoint(o: {
  provider: { handleRequest(request: Request, ctx?: { clientIp?: string }): Promise<Response> }
  manifest: Manifest
  /** The TapeOut name shown in receipts, e.g. '11.1013.tape'. */
  name?: string
  /** Verify links carry the params and result in clear; default false: hashes only. */
  linkContent?: boolean
  version?: string
  /** Called once per JSON-RPC message handled (not for refused requests; usage counting); method and tool are cut to 64 characters; errors in it are ignored. */
  onMessage?: (m: { method: string; tool?: string; clientIp?: string }) => void
}): { /** Renamed from handle in 1.0, like the other entry points. */ handleRequest(request: Request, ctx?: { clientIp?: string }): Promise<Response>; tools: McpTool[] }
