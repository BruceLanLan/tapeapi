// Type declarations for @tapeapi/server/mcp-proxy (hand-written; ../src/mcp-proxy.js is the source of truth).
import type { Manifest } from '@tapeapi/sdk'
import type { McpTool } from '@tapeapi/sdk/mcp'
import type { CreateProviderOptions, ManifestBase } from './index.js'

export declare const MCP_PATH: '/mcp'
/** Upstream answers are refused past this many bytes (1 MiB). */
export declare const UPSTREAM_RESPONSE_LIMIT: number
/** Default upstream time bound in ms, below the provider's 25 s handler timeout. */
export declare const MCP_UPSTREAM_TIMEOUT_MS: number

export type McpProxyUpstream =
  /** A remote MCP server over Streamable HTTP. `headers` are static, operator-set (e.g. authorization); caller headers are never forwarded. */
  | { url: string; headers?: Record<string, string> }
  /** An in-process MCP server: one JSON-RPC message in, its response (or null for a notification) out. */
  | { call(message: object): Promise<object | null> | object | null }

/** The identity part of the manifest; the proxy adds signer, methods and mcp. */
export type McpProxyManifestBase = ManifestBase

export interface McpProxyStats {
  ready: boolean
  upstream: string
  toolsSha256: string | null
  upstreamToolsSha256: string | null
  drift: boolean
  /** invisibleProblems of the last read: while not empty, tools/list and every call are refused. */
  invisible: string[]
  tools: number
  methods: number
  skipped: Array<{ name: string; reason: string }>
  upstreamCalls: number
  upstreamFailures: number
  driftRefusals: number
  hiddenRefusals: number
  refreshes: number
  refreshFailures: number
  lastRefreshOk: boolean | null
  lastRefreshAt: number | null
  provider: Record<string, unknown> | null
}

export interface McpProxy {
  /** Resolves with the manifest once the upstream tools were read; rejects if they could not be. */
  ready: Promise<Manifest>
  /** /.well-known/tapeapi.json and /tapeapi/v1/* (signed envelopes), /mcp (remote MCP, Streamable HTTP). */
  handleRequest(request: Request, ctx?: { clientIp?: string }): Promise<Response>
  /** The manifest with `signer`, generated `methods` and `mcp: { endpoint, toolsSha256 }`; null before ready. */
  manifest(): (Manifest & { mcp: { endpoint: string; toolsSha256: string } }) | null
  /** The upstream tools as last read, verbatim. */
  tools(): McpTool[]
  stats(): McpProxyStats
}

/** An MCP server behind a TapeAPI signing proxy: on-chain identity, tool definitions pinned by digest, signed results. */
export declare function createMcpProxy(o: {
  upstream: McpProxyUpstream
  manifestBase: McpProxyManifestBase
  signerKey: string
  fetch?: typeof fetch
  log?: (...args: unknown[]) => void
  rateLimit?: CreateProviderOptions['rateLimit']
  /** Re-read the upstream tools at least this often (default 60000). */
  refreshMs?: number
  /** The digest the holder published on chain; without it, the digest read at boot. */
  toolsSha256?: string
  /** The TapeOut name shown in receipts, e.g. '11.1013.tape'. */
  name?: string
  /** Verify links carry the params and result in clear; default false: hashes only. */
  linkContent?: boolean
  /** Default: endpoints.live[0] with /tapeapi/v1 replaced by /mcp. */
  mcpEndpoint?: string
  allowHttp?: boolean
  upstreamTimeoutMs?: number
}): McpProxy
