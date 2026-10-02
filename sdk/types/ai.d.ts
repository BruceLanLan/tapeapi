// Type declarations for @tapeapi/sdk/ai (hand-written; ../src/ai.js is the source of truth).
import type { FetchLike } from './common.js'

/** The manifest field carrying { endpoints, models } (one constant so a rename is one line). */
export declare const MANIFEST_FIELD: 'ai'
export declare const RECEIPT_HEADER: 'x-tapeapi-receipt'
export declare const RECEIPT_METHOD: 'receipt'
/** Marks an error the sidecar made itself (no upstream answer, no receipt): a transport failure. Informative only. */
export declare const SIDECAR_ERROR_HEADER: 'x-tapeapi-sidecar-error'
/** The header (value RECEIPT_INVALID) on the HTTP 502 a strict createVerifyingFetch answers in place of a whole answer whose receipt fails. */
export declare const VERIFY_ERROR_HEADER: 'x-tapeapi-verify-error'
/** An answer id a sidecar uses as the receipt id: 1 to 128 characters in U+0021–U+007E (TAPI-21 §3.5). @internal */
export declare function isAnswerId(v: unknown): v is string
/** @internal Used by the reference sidecar or the website; not part of the API. */
export declare const MODEL_ID_MAX: number
/** Caller headers a proxy forwards verbatim (besides each format's own `headers` and the x-codex-* / x-stainless-* families). @internal */
export declare const FORWARD_HEADERS: readonly string[]
/** Does a proxy pass this caller header upstream? Never cookies, forwarded / x-forwarded-* / x-real-ip / cf-*, hop-by-hop, host, content-length. @internal */
export declare function forwardsHeader(name: string, formats?: readonly AIFormat[]): boolean

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
   * createVerifyingFetch needs `final` for every format that streams: strict refuses one without it (INVALID_ARGUMENT),
   * otherwise it is reported once. null: never streamed.
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
/** The manifest's AI field (TAPI-20 extension). */
export interface AIField { endpoints: Array<{ format: string; baseUrl: string }>; models: ModelPrice[] }
/** One amount of a receipt: 8 decimals, rounded up. */
export interface ReceiptPrice { currency: Currency; amount: string }

/** An AI usage receipt: a TAPI-21 envelope, with the method and params it is signed over. */
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

/** The URL path after the service root's path, or null when the path is not under it. @internal */
export declare function apiPath(pathname: string, rootPath: string): string | null
export declare function formatFor(verb: string, path: string | null, formats?: readonly AIFormat[]): AIFormat | null
/** @internal Used by the reference sidecar or the website; not part of the API. */
export declare function formatOfMethod(method: string, formats?: readonly AIFormat[]): AIFormat | null
/** sha256 hex (no 0x) of bytes; a string is hashed as UTF-8. */
export declare function sha256Hex(data: Uint8Array | ArrayBuffer | string): string

export interface SseScanner {
  /** Returns the offset in the chunk's bytes just after its last blank line (an event boundary), or -1 when it has none. */
  push(chunk: Uint8Array | ArrayBuffer | string): number
  end(): void
  /** `final`: the format's final event (createSseScanner({ final })) has been dispatched. */
  /** `receiptsAtEnd`: how many receipt comments had arrived when the stream first ended (its final event or its sentinel); null before. */
  /** `eventsAtEnd`, `digestAtEnd`: the event count and the receipt hash at that same point (the final event included), whatever arrived after it in the same chunk; null before. */
  /** `endOffset`: where that point lies in the bytes of the push() that reached it (just after the blank line that dispatched the ending event); null before. */
  /** `ambiguous`: lines that start with U+FEFF other than at the very start of the stream (clients that strip a byte order mark from every line read them differently); `ambiguousAtEnd`: that count at the end, null before. */
  info: { events: number; done: boolean; receipts: string[]; final: boolean; receiptsAtEnd: number | null; eventsAtEnd: number | null; digestAtEnd: string | null; endOffset: number | null; ambiguous: number; ambiguousAtEnd: number | null }
  /** The receipt hash of the events dispatched so far. */
  digest(): string
  state(): { atLineStart: boolean; pendingCR: boolean; eventHasData: boolean; eventHasFields: boolean }
}
/** An incremental byte-level server-sent-events parser that hashes data payloads by the receipt rule. @internal */
export declare function createSseScanner(o?: { sentinel?: string | null; onEvent?: (json: unknown, eventName: string) => void; eventParseLimit?: number; final?: { data?: readonly string[]; event?: readonly string[] } | null }): SseScanner
/** `ambiguous`: lines that start with U+FEFF other than at the very start (clients read them differently); `unfinished`: the stream closes on an event before its blank line (some clients dispatch it). verifyUsageReceipt reports both. */
export declare function scanSse(body: Uint8Array | ArrayBuffer | string, o?: { format?: AIFormat; sentinel?: string | null }): { responseSha256: string; id: string | null; model: string | null; usage: Usage | null; complete: boolean; events: number; done: boolean; receipts: string[]; ambiguous: number; unfinished: boolean }

export declare function usageOf(u: unknown): Usage | null
/** The entry whose id or an alias equals `model` exactly, allowed for `format`; null when none. @internal */
export declare function modelEntryOf(models: ModelPrice[], model: string | null, format?: string): ModelPrice | null
/** What a receipt carries about price: the reported model matched first, the requested one only when none was reported. @internal */
export declare function pricingOf(models: ModelPrice[], o: { reported?: string | null; requested?: string | null; usage?: RawUsage | null; format?: string }): { model: string | null; prices: ReceiptPrice[] | null; modelMatchedBy?: 'response' | 'request'; unpriced?: string[] }
/** Is the answer complete: 2xx and, for a stream, the format's final success event seen. @internal */
export declare function completeOf(o: { status: number; stream: boolean; read: { complete?: boolean } | null | undefined }): boolean
/** Validate a manifest's AI field; throws MANIFEST_INVALID. */
export declare function validateAIField(o: unknown, opts?: { allowHttp?: boolean }): AIField

/** @internal Used by the reference sidecar or the website; not part of the API. */
export declare function encodeReceipt(envelope: UsageReceipt): string
/** The `: tapeapi-receipt <base64url>` line, without its line end. @internal */
export declare function receiptComment(envelope: UsageReceipt): string
export declare function decodeReceiptHeader(value: string | null): UsageReceipt
/** The last `: tapeapi-receipt` comment of an event-stream text, decoded; null when there is none. */
export declare function readSseReceipt(text: string | Uint8Array): UsageReceipt | null
/** @internal Used by the reference sidecar or the website; not part of the API. */
export declare function envelopeProblems(env: unknown): string[]
/** @internal Used by the reference sidecar or the website; not part of the API. */
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

/** The clients' session headers among the forwarded ones: x-claude-code-session-id, session-id, thread-id. @internal */
export declare const SESSION_HEADERS: readonly string[]
/** @internal Used by the reference sidecar or the website; not part of the API. */
export declare function isSessionHeader(name: string): boolean

/**
 * A fetch for an official SDK (`new OpenAI({ baseURL, fetch })`) that verifies every usage receipt. A stream ends at its
 * format's final event, at its sentinel (`[DONE]`) or when the upstream closes, whichever comes first. Strict: chunks go
 * on as they come until the one in which the stream ends, which is released only once a receipt that came before the
 * end verifies; otherwise the stream errors and the SDK's iterator throws RECEIPT_INVALID. Not strict: nothing is held,
 * the verdict goes to onReport. Nothing waits for the upstream to close, and an upstream that breaks off after the end
 * (strict: once verified) does not fail the call. A request to a metered path that
 * is not addressed to one of the manifest's `ai` endpoints (e.g. localhost for 127.0.0.1), or a metered path written
 * loosely ('//', a percent-encoded letter, a trailing '/'), is refused with INVALID_ARGUMENT before it is sent
 * (strict), or passed on with an onReport of `mismatch: true` (not strict).
 * Strict, a whole answer whose receipt fails: an HTTP 502 in the request format's error shape (code RECEIPT_INVALID) with
 * `x-should-retry: false` and `x-tapeapi-verify-error: RECEIPT_INVALID`, onReport as always; the official SDKs throw an
 * APIError and do not retry it, a caller of the fetch itself checks `res.ok`. Retrying a paid call after other 5xx
 * errors is the caller's choice.
 */
export declare function createVerifyingFetch(o: {
  /** From api.resolve() (or a target api.resolve accepts, resolved on first use). */
  service: any
  api?: { resolve(target: any): Promise<any>; refresh?(svc: any): Promise<any> }
  fetch?: FetchLike
  /** sidecarError: an answer the sidecar made itself (code PROVIDER_UNAVAILABLE, or RATE_LIMITED for 429), never verified. */
  onReport?: (report: VerifyReport & { url: string; stream: boolean; status: number; salted: boolean; incomplete?: boolean; sidecarError?: true; code?: 'PROVIDER_UNAVAILABLE' | 'RATE_LIMITED'; mismatch?: true; expected?: string }) => void
  /** Append 64 random JSON whitespace characters to a JSON request body on a receipt path (the request hash becomes unguessable); default true. */
  salt?: boolean
  /** On a problem: an HTTP 502 RECEIPT_INVALID for a whole answer, an error for a stream, a throw before sending for an endpoint mismatch; default true. */
  strict?: boolean
  /** Default 300. */
  maxSkewS?: number
  /** Default FORMATS. A format that streams must have `stream.final`: strict throws INVALID_ARGUMENT here without it; not strict reports it once. */
  formats?: readonly AIFormat[]
}): (input: any, init?: any) => Promise<Response>
