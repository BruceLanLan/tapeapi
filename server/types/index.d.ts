// Type declarations for @tapeapi/server (hand-written; the JavaScript in ../src is the source of truth).
// Uses the global fetch types (Request, Response); no @types/node needed.
//
// Stability: every declaration is Stable (no breaking change within a major version) unless tagged @experimental (payments,
// ServiceDirectory, bus-privacy and others: outside the compatibility promise; may change in a minor release) or @internal
// (not part of the API). See docs/guides/upgrade-1.0.md and CONTRIBUTING.md.
import type { Rpc, Manifest, ManifestMethod, FetchLike, TxRequest } from '@tapeapi/sdk'

export declare const VERSION: string

/** The identity part of a manifest that createAIProxy and createMcpProxy complete (they add signer, methods and ai / mcp). */
export interface ManifestBase {
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

/** @experimental Outside the compatibility promise (TAPI-22 payments / ServiceDirectory are not deployed); may change in a minor release. A stored voucher (the latest per consumer). */
export interface VoucherRecord {
  consumer: string
  provider: string
  cumulative: string
  expires: number
  sig: string
  signer?: string
  [key: string]: unknown
}

/** @experimental Outside the compatibility promise (TAPI-22 payments / ServiceDirectory are not deployed); may change in a minor release. Voucher store. A store shared by several instances MUST implement advance() as one atomic statement. */
export interface VoucherStore {
  get(consumer: string, provider: string): Promise<VoucherRecord | null>
  set(consumer: string, provider: string, rec: VoucherRecord): Promise<void>
  all?(): Promise<VoucherRecord[]>
  /** Store `rec` only if it raises the counter; resolve to whether it did. */
  advance?(consumer: string, provider: string, rec: VoucherRecord): Promise<boolean>
}

/** @experimental Outside the compatibility promise (TAPI-22 payments / ServiceDirectory are not deployed); may change in a minor release. The default in-process store (lost on restart; one instance only). */
export declare function memoryStore(): Required<VoucherStore>

/** @experimental (TAP draft "Payment Vouchers", TAPs#52) A quote a service stated (§4.4). */
export interface StatedQuote { rate: string; asOf: number; validUntil: number }
/** @experimental Every quote a service stated, shared by all its instances: get(rate) is the quote with that rate string and the latest validUntil. */
export interface QuoteStore {
  /** `container`: the service, so one store can serve several. */
  put(q: StatedQuote, container: string): Promise<void> | void
  get(rate: string, container: string): Promise<StatedQuote | null> | StatedQuote | null
}
/** @experimental The default per-process quote store. */
export declare function memoryQuoteStore(): QuoteStore

/** Context passed to every method handler. */
export interface MethodContext {
  /** @experimental Outside the compatibility promise (TAPI-22 payments / ServiceDirectory are not deployed); may change in a minor release. The paying consumer, or null for a free call. */
  consumer: string | null
  /** @experimental Outside the compatibility promise (TAPI-22 payments / ServiceDirectory are not deployed); may change in a minor release. */
  voucherSigner?: string
  /** @experimental Outside the compatibility promise (TAPI-22 payments / ServiceDirectory are not deployed); may change in a minor release. */
  cumulative?: unknown
  /** @experimental (TAP draft "Payment Vouchers") The charge of this call in base units: only for a manifest with usdPricing. */
  charge?: bigint
  /** The block the answer is pinned to (0 without rpcUrls). */
  block: number
  manifest: Manifest
  method: ManifestMethod
  /** @experimental Outside the compatibility promise (TAPI-22 payments / ServiceDirectory are not deployed); may change in a minor release. Price in base units. */
  price: bigint
  clientIp: string
  /** @experimental A frozen JSON copy of the request's top-level members other than `method` and `params`: its `id`, a `voucher` if sent, and any member TAP-13 does not define (such as `grant`, read by `@tapeapi/interop`). */
  request?: Readonly<{ id?: unknown; voucher?: unknown; [member: string]: unknown }>
  /** @experimental Be told this call's signed envelope (a frozen JSON copy) once it passed every check and is about to be sent; a hook that throws is logged and ignored. Used by `@tapeapi/interop` to keep the answer for a retry of the same id. */
  onSigned?(fn: (env: Readonly<Record<string, unknown>>) => void | Promise<void>): void
  /** @experimental Return `ctx.resend(env)` from a handler to answer with an ok envelope this provider signed earlier over this very request (same id, method, params), byte for byte: not signed or billed again; free calls only, anything else is INTERNAL. */
  resend?(env: Readonly<Record<string, unknown>>): unknown
  [key: string]: unknown
}

/** A method handler: return a JSON-serialisable result, or throw an Error with a TAPI-21 `code` (e.g. 'BAD_REQUEST'). */
export type MethodHandler = (params: Record<string, any>, ctx: MethodContext) => unknown | Promise<unknown>

export interface CreateProviderOptions {
  /** The TAPI-20 manifest (validated; the object is kept by reference). */
  manifest: Manifest | Record<string, unknown>
  /** Private key of the manifest's delegated signer. */
  signerKey: string
  /** One handler per manifest method. */
  methods: Record<string, MethodHandler>
  rpcUrls?: string[]
  quorum?: number
  /** Timeout of one RPC request in ms. Renamed from `timeoutMs` in 1.0: passing `timeoutMs` throws INVALID_ARGUMENT. */
  rpcTimeoutMs?: number
  /** @experimental (2.3) As createRpc's `rpcRetries` (@tapeapi/sdk): extra rounds, at most this many (0 to 5), for a chain
   *  read whose round failed fast and only by the network (a broken or refused connection, DNS, an HTTP 5xx other than a
   *  gateway timeout; never a timeout), each needing the same agreement. Default: the SDK's, 2; 0 turns it off. */
  rpcRetries?: number
  fetch?: FetchLike
  allowSingleNode?: boolean
  /** Development only: allows http:// endpoints, and priced methods whose payment.escrow is the zero address (paid calls are then refused) and
   *  on the in-memory meter without a warning. Only this option switches dev on: since 1.0 a manifest's own `dev` field
   *  does not. */
  dev?: boolean
  /** Accept http:// endpoints (local testing). Relaxes nothing else. */
  allowHttp?: boolean
  /** @experimental Outside the compatibility promise (TAPI-22 payments / ServiceDirectory are not deployed); may change in a minor release. */
  escrow?: string
  /** @experimental (3.0) The token() the escrow must hold: BEM on BNB Smart Chain by default, no default on other chains (the check is skipped). listen() refuses to start when it differs (dev: a log line). From 3.0 every paid call, on any path, waits for the check: a mismatch, an escrow without token() or nodes that cannot read it refuse paid calls with an unsigned 503 (UNSUPPORTED_PAYMENT_TOKEN); not in dev. The escrow is not audited and not deployed. */
  escrowToken?: string
  chainId?: number
  /** @experimental Outside the compatibility promise (TAPI-22 payments / ServiceDirectory are not deployed); may change in a minor release. */
  store?: VoucherStore
  /** @experimental Outside the compatibility promise (TAPI-22 payments / ServiceDirectory are not deployed); may change in a minor release. Say that a priced service on the in-memory store is intended (silences the warning). */
  allowMemoryStore?: boolean
  warn?: (...args: unknown[]) => void
  log?: (...args: unknown[]) => void
  bodyLimit?: number
  handlerTimeoutMs?: number
  requestTimeoutMs?: number
  headersTimeoutMs?: number
  /** @experimental Outside the compatibility promise (TAPI-22 payments / ServiceDirectory are not deployed); may change in a minor release. */
  minVoucherLifeS?: number
  /** false disables the built-in rate limiter. */
  rateLimit?: false | { windowMs?: number; free?: number; paid?: number; max?: number; ip?: number; /** @experimental (TAP draft) quote requests (a priced call without a voucher) to a service with usdPricing; default: free */ quote?: number }
  /** Proxy header that carries the client IP (e.g. 'cf-connecting-ip'); unset, the socket peer is used. */
  clientIpHeader?: string
  /** @experimental Outside the compatibility promise (TAPI-22 payments / ServiceDirectory are not deployed); may change in a minor release. */
  escrowCacheMs?: number
  /** @experimental Outside the compatibility promise (TAPI-22 payments / ServiceDirectory are not deployed); may change in a minor release. */
  sessionCacheMs?: number
  blockCacheMs?: number
  /** @experimental Outside the compatibility promise (TAPI-22 payments / ServiceDirectory are not deployed); may change in a minor release. */
  contributionCacheMs?: number
  cacheMax?: number
  /** @experimental Outside the compatibility promise (TAPI-22 payments / ServiceDirectory are not deployed); may change in a minor release. */
  withdrawCloseS?: number
  /** @experimental (TAP draft "Payment Vouchers"; a manifest with usdPricing) The rate source: USD per 1 BEM and the end of its averaging period. Default: the manifest's own rateSources. */
  usdRate?: () => Promise<{ rate: string | number; asOf?: number }>
  /** @experimental How long a quote stays valid, 1..usdPricing.maxQuoteS (default maxQuoteS). */
  quoteValidS?: number
  /** @experimental Shared by every instance behind the URL (default memoryQuoteStore()). */
  quoteStore?: QuoteStore
  /** @experimental F2, F4 and F3 of the draft's §2.2 from configuration instead of the TapeAPIEscrow reads. */
  settlementFacts?: {
    amountPaid(consumer: string): Promise<bigint | string | number>
    fundsAvailable(consumer: string): Promise<bigint | string | number>
    keyAuthorisedUntil(consumer: string, key: string): Promise<bigint | string | number>
  }
  /** @experimental (phase 1, prototype) another enforcement backend's payment acceptance (e.g. x402Acceptance from
   *  @tapeapi/sdk/agent); without it the TAPI-22 escrow vouchers are checked as before. Not with usdPricing. */
  enforcement?: { name: string; verifyVoucher(voucher: unknown, price: bigint): Promise<{ consumer: string; signer: string; cumulative: bigint; commit(): Promise<void>; release(): void }>; terms?(): { settlement: string; receiver: string } }
}

/** A Node http.Server (typed structurally so consumers need no @types/node). */
export interface ListeningServer {
  address(): unknown
  close(cb?: (err?: Error) => void): unknown
  [key: string]: any
}

/** @experimental Outside the compatibility promise (TAPI-22 payments / ServiceDirectory are not deployed); may change in a minor release. */
export interface Settlement extends VoucherRecord { deadline: number }

export interface Provider {
  /** Fetch-style entry point (Cloudflare Workers, Deno, Bun, Node 22+). */
  handleRequest(request: Request, ctx?: { clientIp?: string }): Promise<Response>
  /** Node only: start an http server (default port 0 = random, host 127.0.0.1). */
  listen(port?: number, host?: string): Promise<ListeningServer>
  close(): Promise<void>
  /** Node http request listener, for use with your own server. */
  handler(req: any, res: any): void
  /** Dispatch one parsed request body without HTTP (tests, custom transports). */
  invoke(body: unknown, opts?: { ip?: string; sentMethod?: string }): Promise<Record<string, unknown>>
  stats(): Record<string, unknown>
  /** @experimental Outside the compatibility promise (TAPI-22 payments / ServiceDirectory are not deployed); may change in a minor release. */
  pendingSettlements(): Promise<Settlement[]>
  /** @experimental Outside the compatibility promise (TAPI-22 payments / ServiceDirectory are not deployed); may change in a minor release. */
  dueSettlements(opts?: { marginS?: number }): Promise<Array<Settlement & { reason: 'deadline' | 'withdraw-requested' }>>
  /** @experimental Outside the compatibility promise (TAPI-22 payments / ServiceDirectory are not deployed); may change in a minor release. Build the escrow settle transaction for a voucher; send it with your own wallet. */
  settleTx(v: { consumer: string; provider: string; cumulative: string | bigint; expires: number | bigint; sig: string }): TxRequest
  /** @experimental Outside the compatibility promise (TAPI-22 payments / ServiceDirectory are not deployed); may change in a minor release. */
  contribution(): Promise<number | null>
  currentBlock(): Promise<number>
  /** @experimental (3.0) Read the escrow's token() and compare it with escrowToken (BEM on BNB Smart Chain). listen() calls it and refuses a mismatch. From 3.0 paid calls run it themselves on any path (a Worker no longer needs to await it): 'ok', 'skipped' and 'mismatch' are kept for this instance, 'unreadable' and 'no-token' refuse paid calls and are read again at the next one. Once an answer is kept, calling this returns it without reading again (it never replaces it); before that, it reads. Never a match unless 'ok'. */
  checkEscrowToken(): Promise<{ status: 'ok' | 'mismatch' | 'no-token' | 'unreadable' | 'skipped'; escrow: string | null; token: string | null; expected: string | null; message: string }>
  manifest: Manifest
  container: string
  signer: string
  /** @experimental Outside the compatibility promise (TAPI-22 payments / ServiceDirectory are not deployed); may change in a minor release. */
  escrow: string | undefined
  chainId: number
  /** @experimental Outside the compatibility promise (TAPI-22 payments / ServiceDirectory are not deployed); may change in a minor release. */
  store: VoucherStore
  rpc: Rpc | null
  version: string
  readonly server: ListeningServer | null
}

export declare function createProvider(opts: CreateProviderOptions): Provider
