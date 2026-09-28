// Type declarations for @tapeapi/server/ai-proxy (hand-written; ../src/ai-proxy.js is the source of truth).
import type { Manifest } from '@tapeapi/sdk'
import type { ModelPrice, AIField, AIFormat } from '@tapeapi/sdk/ai'
import type { CreateProviderOptions } from './index.js'

/** Request bodies are refused past this many bytes (4 MiB). */
export declare const REQUEST_LIMIT: number
/** Non-stream upstream answers are refused past this many bytes (16 MiB); streams are not capped. */
export declare const RESPONSE_LIMIT: number
/** 120 s: a non-stream answer must be complete, a stream must have started. */
export declare const UPSTREAM_TIMEOUT_MS: number
export declare const RECEIPT_TTL_MS: number
export declare const MAX_RECEIPTS: number
/** At most this many bytes of one event are held back (4 MiB); past it the event streams and the receipt is appended. */
export declare const HOLD_LIMIT: number

/** The identity part of the manifest; the sidecar adds signer, methods (receipt) and the AI field. */
export interface AIProxyManifestBase {
  tapeapi?: string
  name?: string
  circuits: string
  tokenId: string
  container: string
  delegation?: { expires: number; sig: string } | null
  endpoints: { live: string[]; async: boolean }
  dev?: boolean
  [key: string]: unknown
}

export interface AIProxyStats {
  ready: boolean
  version: string
  upstream: string
  endpoints: Array<{ format: string; baseUrl: string }>
  /** The configured format adapters, by name. */
  formats: string[]
  models: number
  receiptsKept: number
  requests: number
  receipts: number
  streams: number
  passThrough: number
  /** Upstream answers with HTTP >= 400 (passed through, signed with usage null). */
  upstreamErrors: number
  upstreamFailures: number
  timeouts: number
  tooLarge: number
  redirects: number
  rateLimited: number
  duplicateIds: number
  lookups: number
  misses: number
  /** Streamed requests the sidecar asked upstream usage for. */
  usageInjected: number
  /** Streams whose receipt was appended at the end (no final event seen). */
  appended: number
  /** Models the upstream reported that the price table does not list (their receipts carry price null). */
  unpricedModels: string[]
  provider: Record<string, unknown>
}

export interface AIProxy {
  /** Resolves with the manifest (the sidecar needs no upstream read to start). */
  ready: Promise<Manifest>
  /** /v1/* under the service root (passed through, receipts added), /.well-known/tapeapi.json, /tapeapi/v1/health, /tapeapi/v1/receipt. */
  handleRequest(request: Request, ctx?: { clientIp?: string }): Promise<Response>
  manifest(): Manifest & { ai: AIField }
  stats(): AIProxyStats
}

/** A TapeAPI signing sidecar in front of an AI API: byte-for-byte pass-through, signed usage receipts per format adapter. */
export declare function createAIProxy(o: {
  /** The upstream's /v1 base (every format's /v1/... path goes under it); configuration only. `headers` are operator-set and sent on every upstream request. */
  upstream: { baseUrl: string; headers?: Record<string, string> }
  manifestBase: AIProxyManifestBase
  signerKey: string
  /** The price table published in the manifest's AI field (1 to 256 entries, prices per 1M tokens). */
  models: ModelPrice[]
  /** The API format adapters (default ai.FORMATS: OpenAI chat, completions, embeddings). */
  formats?: readonly AIFormat[]
  fetch?: typeof fetch
  log?: (...args: unknown[]) => void
  /** Passed to createProvider; its `ip` budget (default free + paid) also bounds /v1/* per IP. false: off. */
  rateLimit?: CreateProviderOptions['rateLimit']
  /** How long receipts stay retrievable (default 3 600 000). */
  receiptTtlMs?: number
  /** At most this many receipts are kept (default 50 000). */
  maxReceipts?: number
  /** The service root the endpoints are built on; default endpoints.live[0] without /tapeapi/v1. */
  publicUrl?: string
  allowHttp?: boolean
  /** Default 120 000. */
  upstreamTimeoutMs?: number
}): AIProxy
