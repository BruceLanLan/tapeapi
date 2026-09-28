// Type declarations for @tapeapi/server/ai-proxy (hand-written; ../src/ai-proxy.js is the source of truth).
import type { Manifest } from '@tapeapi/sdk'
import type { ModelPrice, AIField, AIFormat } from '@tapeapi/sdk/ai'
import type { CreateProviderOptions } from './index.js'

/** Request bodies are refused past this many bytes (32 MiB). */
export declare const REQUEST_LIMIT: number
/** Non-stream upstream answers are refused past this many bytes (16 MiB); streams are not capped. */
export declare const RESPONSE_LIMIT: number
/** 600 s: a non-stream answer must be complete, a stream must have started. */
export declare const UPSTREAM_TIMEOUT_MS: number
/** 300 s: a stream that sends nothing this long is ended (receipt appended, complete false). */
export declare const STREAM_IDLE_MS: number
export declare const RECEIPT_TTL_MS: number
export declare const MAX_RECEIPTS: number
/** The `receipt` method's own budget per client IP per minute (10). */
export declare const RECEIPT_LOOKUPS_PER_MIN: number
/** Upstream answer ids estimated below this many bits (64) count as guessable. */
export declare const ID_ENTROPY_MIN_BITS: number
/** A rough upper-bound estimate of the random bits in an answer id, from its shape ("chatcmpl-417": 9). */
export declare function idEntropyBits(id: string): number
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
  /** Streams ended because the upstream sent nothing for streamIdleMs. */
  idleTimeouts: number
  tooLarge: number
  redirects: number
  rateLimited: number
  /** Answers whose id was shared with another kept receipt (kept apart by requestSha256). */
  duplicateIds: number
  /** `receipt` lookups refused by the method's own per-IP budget (unsigned 429). */
  receiptRateLimited: number
  /** Upstream ids estimated below ID_ENTROPY_MIN_BITS. */
  guessableIds: number
  /** The fewest estimated bits an upstream id has shown; null before the first. */
  idEntropyMinBits: number | null
  /** Whether the upstream's ids have looked guessable (low estimate, or one id seen twice while kept). */
  guessableIdsSeen: boolean
  /** Whether a lookup must name requestSha256 too. */
  requireRequestHash: boolean
  /** Whether the clients' session headers are passed upstream. */
  forwardSessionHeaders: boolean
  lookups: number
  misses: number
  /** Streamed requests the sidecar asked upstream usage for. */
  usageInjected: number
  /** Streams whose receipt was appended at the end (no final event seen). */
  appended: number
  /** 2xx answers signed with complete false. */
  incomplete: number
  /** Models the upstream reported that the price table does not list (their receipts carry prices null). */
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
  /** How long receipts stay retrievable (default 3 600 000; TAP-21 §3.5 recommends at least an hour). */
  receiptTtlMs?: number
  /** The `receipt` method's own budget per client IP (default { ip: 10, windowMs: 60 000 }); false: off. */
  receiptRateLimit?: { ip?: number; windowMs?: number } | false
  /** Answer a `receipt` lookup only when it names requestSha256 too (TAP-21 §3.5 MAY); default false. */
  requireRequestHash?: boolean
  /** Pass the clients' session headers (x-claude-code-session-id, session-id, thread-id) upstream; default true. */
  forwardSessionHeaders?: boolean
  /** At most this many receipts are kept (default 50 000). */
  maxReceipts?: number
  /** The service root the endpoints are built on; default endpoints.live[0] without /tapeapi/v1. */
  publicUrl?: string
  allowHttp?: boolean
  /** Default 600 000. */
  upstreamTimeoutMs?: number
  /** A stream silent this long is ended; default 300 000, 0 = never. */
  streamIdleMs?: number
}): AIProxy
