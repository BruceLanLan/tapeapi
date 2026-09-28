// Type declarations for @tapeapi/sdk/ai (hand-written; ../src/ai.js is the source of truth).
import type { FetchLike } from './common.js'

/** The manifest field carrying { endpoints, models } (one constant so a rename is one line). */
export declare const MANIFEST_FIELD: 'ai'
export declare const RECEIPT_HEADER: 'x-tapeapi-receipt'
export declare const SSE_RECEIPT_PREFIX: ': tapeapi-receipt '
export declare const RECEIPT_METHOD: 'receipt'
/** Marks an error the sidecar made itself (no upstream answer, no receipt): a transport failure. Informative only. */
export declare const SIDECAR_ERROR_HEADER: 'x-tapeapi-sidecar-error'
/** An answer id a sidecar uses as the receipt id: 1 to 128 characters in U+0021–U+007E (TAP-21 §3.5). */
export declare function isAnswerId(v: unknown): v is string
export declare const PRICE_UNIT: '1M tokens'
export declare const CURRENCIES: readonly Currency[]
export declare const MODELS_MAX: number
export declare const ENDPOINTS_MAX: number
export declare const MODEL_ID_MAX: number
/** At most 16 aliases per model entry. */
export declare const ALIASES_MAX: number
/** At most 7 price entries (one per currency) per model entry. */
export declare const PRICES_MAX: number
/** Caller headers a proxy forwards verbatim (besides each format's own `headers` and the FORWARD_PREFIXES families). */
export declare const FORWARD_HEADERS: readonly string[]
/** Header-name prefixes a proxy forwards: x-codex-*, x-stainless-*. */
export declare const FORWARD_PREFIXES: readonly string[]
/** Does a proxy pass this caller header upstream? Never cookies, forwarded / x-forwarded-* / x-real-ip / cf-*, hop-by-hop, host, content-length. */
export declare function forwardsHeader(name: string, formats?: readonly AIFormat[]): boolean
/** Prices carry at most, amounts exactly, this many decimals (8). */
export declare const AMOUNT_DECIMALS: number
/** An event's data is parsed as JSON (for the adapter) up to this many bytes; it is hashed whatever its size. */
export declare const EVENT_PARSE_LIMIT: number

export type Currency = 'BEM' | 'BNB' | 'USDT' | 'USDC' | 'ETH' | 'USD1' | 'USD'
/** Counts as an adapter reads them; the core normalises and checks them. */
export interface RawUsage { prompt_tokens?: unknown; completion_tokens?: unknown; total_tokens?: unknown; cache_read_tokens?: unknown; cache_write_tokens?: unknown; cache_write_1h_tokens?: unknown; reasoning_tokens?: unknown; other?: unknown }
/**
 * The receipt's usage, one convention for every format: prompt_tokens is ALL input (cache reads and writes included),
 * completion_tokens all output (reasoning included); the cache and reasoning counts are subsets (cache_write_1h_tokens of
 * cache_write_tokens); `other` holds per-use counts (e.g. web_search_requests). Keys always in this order.
 */
export interface Usage {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  cache_read_tokens?: number
  cache_write_tokens?: number
  cache_write_1h_tokens?: number
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
  /** A whole answer's id, model and usage; `complete: false` marks an answer the format itself says is unfinished. */
  response(json: unknown): { id: string | null; model: string | null; usage: RawUsage | null; complete?: boolean }
  /** Folds a stream's JSON events; `complete`: the format's final success event was seen (and no error event). */
  streamState(): { event(json: unknown, eventName: string): void; result(): { id: string | null; model: string | null; usage: RawUsage | null; complete: boolean } }
}
/** The built-in formats: OpenAI Chat Completions, OpenAI Responses, Anthropic Messages, OpenAI Embeddings. */
export declare const FORMATS: readonly AIFormat[]

/**
 * Prices per 1M tokens in one currency, decimal strings with at most 8 decimals. cacheRead and cacheWrite default to
 * `input`, cacheWrite1h to cacheWrite then `input`; without `reasoning`, reasoning tokens are output.
 */
export interface TokenPrice { currency: Currency; unit: '1M tokens'; input: string; output: string; cacheRead?: string; cacheWrite?: string; cacheWrite1h?: string; reasoning?: string }
/**
 * One entry of the price table: matched when the reported (or, if none was reported, the requested) model equals `id` or
 * one of `aliases` exactly; `formats` limits it to some endpoints; `prices` has one entry per currency (1 to 7).
 */
export interface ModelPrice { id: string; aliases?: string[]; formats?: string[]; prices: TokenPrice[] }
/** The manifest's AI field (TAP-20 extension). */
export interface AIField { endpoints: Array<{ format: string; baseUrl: string }>; models: ModelPrice[] }
/** One amount of a receipt: 8 decimals, rounded up. */
export interface ReceiptPrice { currency: Currency; amount: string }

/** An AI usage receipt: a TAP-21 envelope, with the method and params it is signed over. */
export interface UsageReceipt {
  id: string
  ok: true
  result: {
    /** The model the upstream reported, or the requested one when modelMatchedBy is 'request'. */
    model: string | null
    usage: Usage | null
    responseSha256: string
    stream: boolean
    /** A finished answer (2xx; a stream reached its format's final success event). An incomplete answer is still priced. */
    complete: boolean
    /** The upstream's HTTP status; outside 2xx, usage and prices are null. */
    status: number
    /** One amount per currency of the matched entry, in its order; null when no entry matched or there is no usage. */
    prices: ReceiptPrice[] | null
    /** How the price-table entry was found; present exactly when one matched. */
    modelMatchedBy?: 'response' | 'request'
    /** usage.other names, billed per use and not priced by the table; only with prices. */
    unpriced?: string[]
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
export declare function scanSse(body: Uint8Array | ArrayBuffer | string, o?: { format?: AIFormat; sentinel?: string | null }): { responseSha256: string; id: string | null; model: string | null; usage: Usage | null; complete: boolean; events: number; done: boolean; receipts: string[] }

export declare function usageOf(u: unknown): Usage | null
/** Disjoint buckets per 1M tokens (input, cache reads, cache writes, 1-hour cache writes, output, reasoning), rounded up once, exactly 8 decimals; BigInt only. */
export declare function amountOf(price: Omit<TokenPrice, 'currency' | 'unit'> & Partial<TokenPrice>, usage: RawUsage): string
/** The entry whose id or an alias equals `model` exactly, allowed for `format`; null when none. */
export declare function modelEntryOf(models: ModelPrice[], model: string | null, format?: string): ModelPrice | null
/** A matched entry's amounts for a usage, one per currency; null without usage. */
export declare function pricesOf(entry: ModelPrice | null, usage: RawUsage | null): ReceiptPrice[] | null
/** What a receipt carries about price: the reported model matched first, the requested one only when none was reported. */
export declare function pricingOf(models: ModelPrice[], o: { reported?: string | null; requested?: string | null; usage?: RawUsage | null; format?: string }): { model: string | null; prices: ReceiptPrice[] | null; modelMatchedBy?: 'response' | 'request'; unpriced?: string[] }
/** Is the answer complete: 2xx and, for a stream, the format's final success event seen. */
export declare function completeOf(o: { status: number; stream: boolean; read: { complete?: boolean } | null | undefined }): boolean
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
  /** Whether the answer you received is complete (compared with the receipt's `complete`); worked out from responseBytes or `answer` when absent. */
  complete?: boolean
  /** Your own reading of the answer (e.g. an adapter's streamState().result()), when you hold only its hash; read from responseBytes otherwise. */
  answer?: { id?: string | null; model?: string | null; usage?: RawUsage | null; complete?: boolean }
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
  /** sidecarError: an answer the sidecar made itself (code PROVIDER_UNAVAILABLE, or RATE_LIMITED for 429), never verified. */
  onReport?: (report: VerifyReport & { url: string; stream: boolean; status: number; incomplete?: boolean; sidecarError?: true; code?: 'PROVIDER_UNAVAILABLE' | 'RATE_LIMITED' }) => void
  /** Throw (or error the stream) on a problem; default true. */
  strict?: boolean
  /** Default 300. */
  maxSkewS?: number
  formats?: readonly AIFormat[]
}): (input: any, init?: any) => Promise<Response>
