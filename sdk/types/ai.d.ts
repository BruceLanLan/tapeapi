// Type declarations for @tapeapi/sdk/ai (hand-written; ../src/ai.js is the source of truth).
import type { FetchLike } from './common.js'

/** The manifest field carrying { endpoints, models } (one constant so a rename is one line). */
export declare const MANIFEST_FIELD: 'ai'
export declare const RECEIPT_HEADER: 'x-tapeapi-receipt'
export declare const SSE_RECEIPT_PREFIX: ': tapeapi-receipt '
export declare const RECEIPT_METHOD: 'receipt'
export declare const PRICE_UNIT: '1M tokens'
export declare const CURRENCIES: readonly Currency[]
export declare const MODELS_MAX: number
export declare const ENDPOINTS_MAX: number
export declare const MODEL_ID_MAX: number
/** Prices carry at most, amounts exactly, this many decimals (8). */
export declare const AMOUNT_DECIMALS: number
/** An event's data is parsed as JSON (for the adapter) up to this many bytes; it is hashed whatever its size. */
export declare const EVENT_PARSE_LIMIT: number

export type Currency = 'BEM' | 'BNB' | 'USDT' | 'USDC' | 'ETH' | 'USD'
/** Counts as an adapter reads them; the core normalises and checks them. */
export interface RawUsage { prompt_tokens?: unknown; completion_tokens?: unknown; total_tokens?: unknown; cache_read_tokens?: unknown; cache_write_tokens?: unknown; reasoning_tokens?: unknown; other?: unknown }
/**
 * The receipt's usage, one convention for every format: prompt_tokens is ALL input (cache reads and writes included),
 * completion_tokens all output (reasoning included); the cache and reasoning counts are subsets; `other` holds per-use
 * counts (e.g. web_search_requests). Keys always in this order.
 */
export interface Usage {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  cache_read_tokens?: number
  cache_write_tokens?: number
  reasoning_tokens?: number
  other?: Record<string, number>
}

/**
 * One API format (OpenAI chat, OpenAI embeddings, ...): the only place that knows a vendor's JSON. Pure data and
 * small functions; the sidecar and every verifier use the same adapters.
 */
export interface AIFormat {
  /** The format, e.g. 'openai-chat' (the manifest's endpoint `format`). */
  name: string
  /** The receipt method, e.g. 'openai_chat'. */
  method: string
  /** What a client's base URL adds to the service root: '/v1' for OpenAI's SDKs, '' for Anthropic's. */
  baseSuffix: string
  /** Does this request belong to the format? `path` is the API path from the service root, e.g. '/v1/chat/completions'. */
  match(req: { verb: string; path: string }): boolean
  /** Caller headers the format needs upstream (its auth, its flags). */
  headers?: readonly string[]
  /** Upstream response headers a browser client may read. */
  exposeHeaders?: readonly string[]
  /** The model the request body asks for, or null. */
  requestModel?(body: unknown): string | null
  /**
   * How a streamed answer is framed. `sentinel`: a data payload left out of the hash. `final`: the stream's last event,
   * by its first line (`data: X` or `event: Y`); the receipt comment goes right before it, or at the end when none came.
   * null: never streamed.
   */
  stream: { framing: 'sse'; sentinel: string | null; final?: { data?: readonly string[]; event?: readonly string[] } } | null
  /** May change the body sent upstream (e.g. to ask for usage); `strip` removes the events that caused (isInjectedEvent). */
  prepareUpstream?(body: unknown): { body: unknown; strip: boolean } | null
  isInjectedEvent?(json: unknown): boolean
  /** A whole answer's id, model and usage. */
  response(json: unknown): { id: string | null; model: string | null; usage: RawUsage | null }
  /** Folds a stream's JSON events. */
  streamState(): { event(json: unknown, eventName: string): void; result(): { id: string | null; model: string | null; usage: RawUsage | null } }
}
/** The built-in formats: OpenAI Chat Completions, OpenAI Responses, Anthropic Messages, OpenAI Embeddings. */
export declare const FORMATS: readonly AIFormat[]

/** Prices per 1M tokens, decimal strings with at most 8 decimals. Cache prices default to `input`; without `reasoning`, reasoning tokens are output. */
export interface TokenPrice { currency: Currency; unit: '1M tokens'; input: string; output: string; cacheRead?: string; cacheWrite?: string; reasoning?: string }
/** One entry of the price table; `formats` limits it to some endpoints. */
export interface ModelPrice { id: string; formats?: string[]; price: TokenPrice }
/** The manifest's AI field (TAP-20 extension). */
export interface AIField { endpoints: Array<{ format: string; baseUrl: string }>; models: ModelPrice[] }
/** A receipt's price: the table entry used, the amount, and the per-use counts no token price covers. */
export interface Price { currency: Currency; input: string; output: string; cacheRead?: string; cacheWrite?: string; reasoning?: string; amount: string; unpriced?: string[] }

/** An AI usage receipt: a TAP-21 envelope, with the method and params it is signed over. */
export interface UsageReceipt {
  id: string
  ok: true
  result: {
    model: string | null
    usage: Usage | null
    responseSha256: string
    stream: boolean
    price: Price | null
    /** The upstream's HTTP status (an addition to the A2 field list: failed calls are signed too, with usage null). */
    status?: number
    /** The sidecar asked the upstream for usage the client did not ask for (and stripped what that added). */
    usageInjected?: true
  }
  container: string
  ts: number
  method: string
  params: { path: string; requestSha256: string }
  sig: string
}

export interface VerifyReport {
  /** true when there are no problems (unchecked parts are listed, not failed). */
  ok: boolean
  problems: string[]
  warnings: string[]
  /** 'request', 'response', 'freshness': what was not given and so not checked. */
  unchecked: string[]
  receipt: UsageReceipt | null
}

/** The URL path after the service root's path, or null when the path is not under it. */
export declare function apiPath(pathname: string, rootPath: string): string | null
/** The service root of an endpoint's baseUrl (the baseUrl minus the format's suffix), or null. */
export declare function rootOf(baseUrl: string, format: AIFormat | null | undefined): string | null
export declare function formatFor(verb: string, path: string | null, formats?: readonly AIFormat[]): AIFormat | null
export declare function formatOfMethod(method: string, formats?: readonly AIFormat[]): AIFormat | null
export declare function sentinelOf(method: string, formats?: readonly AIFormat[]): string | null
/** sha256 hex (no 0x) of bytes; a string is hashed as UTF-8. */
export declare function sha256Hex(data: Uint8Array | ArrayBuffer | string): string
/** A stream's responseSha256 from its data payloads, in order (the sentinel's events left out). */
export declare function sseDigestOfPayloads(payloads: Array<string | Uint8Array>, o?: { sentinel?: string | null }): string

export interface SseScanner {
  push(chunk: Uint8Array | ArrayBuffer | string): void
  end(): void
  info: { events: number; done: boolean; receipts: string[] }
  /** The receipt hash of the events dispatched so far. */
  digest(): string
  state(): { atLineStart: boolean; pendingCR: boolean; eventHasData: boolean; eventHasFields: boolean }
}
/** An incremental byte-level server-sent-events parser that hashes data payloads by the receipt rule. */
export declare function createSseScanner(o?: { sentinel?: string | null; onEvent?: (json: unknown, eventName: string) => void; eventParseLimit?: number }): SseScanner
export declare function scanSse(body: Uint8Array | ArrayBuffer | string, o?: { format?: AIFormat; sentinel?: string | null }): { responseSha256: string; id: string | null; model: string | null; usage: Usage | null; events: number; done: boolean; receipts: string[] }

export declare function usageOf(u: unknown): Usage | null
/** Disjoint buckets per 1M tokens (input, cache reads, cache writes, output, reasoning), rounded up once, exactly 8 decimals; BigInt only. */
export declare function amountOf(price: Omit<TokenPrice, 'currency' | 'unit'> & Partial<TokenPrice>, usage: RawUsage): string
/** The price for the model the upstream reported (exact id match, format allowed) and its usage, or null. */
export declare function priceOf(models: ModelPrice[], model: string | null, usage: RawUsage | null, format?: string): Price | null
/** Validate a manifest's AI field; throws MANIFEST_INVALID. */
export declare function validateAIField(o: unknown, opts?: { allowHttp?: boolean }): AIField

export declare function encodeReceipt(envelope: UsageReceipt): string
/** The `: tapeapi-receipt <base64url>` line, without its line end. */
export declare function receiptComment(envelope: UsageReceipt): string
export declare function decodeReceiptHeader(value: string | null): UsageReceipt
/** The last `: tapeapi-receipt` comment of an event-stream text, decoded; null when there is none. */
export declare function readSseReceipt(text: string | Uint8Array): UsageReceipt | null
export declare function envelopeProblems(env: unknown): string[]
export declare function priceProblems(field: { models: ModelPrice[] }, result: UsageReceipt['result'], format?: string): string[]

/** Check one receipt against a trusted (resolved) manifest and the bytes you sent and received. Pure: no network. */
export declare function verifyUsageReceipt(o: {
  envelope: UsageReceipt | Record<string, unknown> | null
  manifest: { container: string; signer: string; [k: string]: unknown }
  requestBytes?: Uint8Array | ArrayBuffer | string
  /** Non-stream: the body; stream: the raw event-stream bytes. */
  responseBytes?: Uint8Array | ArrayBuffer | string
  sseDataPayloads?: Array<string | Uint8Array>
  responseSha256?: string
  stream?: boolean
  /** The API path the request went to, e.g. '/v1/chat/completions'. */
  path?: string
  status?: number
  now?: number
  /** Check |now - ts| <= maxSkewS; not checked when absent. */
  maxSkewS?: number
  formats?: readonly AIFormat[]
}): VerifyReport

/** A fetch for an official SDK (`new OpenAI({ baseURL, fetch })`) that verifies every usage receipt (streams when they end). */
export declare function createVerifyingFetch(o: {
  /** From api.resolve() (or a target api.resolve accepts, resolved on first use). */
  service: any
  api?: { resolve(target: any): Promise<any>; refresh?(svc: any): Promise<any> }
  fetch?: FetchLike
  onReport?: (report: VerifyReport & { url: string; stream: boolean; status: number; incomplete?: boolean }) => void
  /** Throw (or error the stream) on a problem; default true. */
  strict?: boolean
  /** Default 300. */
  maxSkewS?: number
  formats?: readonly AIFormat[]
}): (input: any, init?: any) => Promise<Response>
