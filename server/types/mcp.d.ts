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
}): {
  /** Renamed from handle in 1.0, like the other entry points. */ handleRequest(request: Request, ctx?: { clientIp?: string }): Promise<Response>
  tools: McpTool[]
  /** @experimental (2.3) The toolsSha256 (TAPI-20 §3.8) of this endpoint's tools/list answer, 64 lowercase hex digits. */
  toolsSha256(): Promise<string>
}
/** @experimental (2.3) The tools/list answer createMcpEndpoint gives for this manifest, as a client receives it. */
export declare function listedMcpTools(manifest: Manifest): Promise<McpTool[]>
/** @experimental (2.3) The toolsSha256 (TAPI-20 §3.8) of listedMcpTools(manifest): what a holder publishes as mcp.toolsSha256. */
export declare function mcpToolsSha256(manifest: Manifest): Promise<string>
/**
 * @experimental (2.3) A handler table for createProvider whose bound methods (tools of createMcpEndpoint) are refused
 * with a signed TOOLS_CHANGED (409, data { published, current }) while the tools no longer hash to `published`
 * (TAPI-20 §3.8, TAP draft #16 §5.1); other methods pass through unchanged. While the tool list cannot be built, every
 * method is refused (TOOLS_CHANGED, current null) and the next call tries again; a list once read is kept.
 */
export declare function holdToToolsSha256<T extends Record<string, (params: any, ctx?: any) => unknown>>(methods: T, o: { manifest: Manifest; published: string }): T
