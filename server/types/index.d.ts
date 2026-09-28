// Type declarations for @tapeapi/server (hand-written; the JavaScript in ../src is the source of truth).
// Uses the global fetch types (Request, Response); no @types/node needed.
//
// Stability (1.0): every declaration is Stable (no breaking change within 1.x) unless tagged @experimental (payments,
// ServiceDirectory: may change in a 1.x minor release) or @internal (not part of the API). See docs/guides/upgrade-1.0.md.
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

/** @experimental Not covered by the 1.0 stability promise (TAP-22 payments / ServiceDirectory are not deployed); may change in a 1.x minor release. A stored voucher (the latest per consumer). */
export interface VoucherRecord {
  consumer: string
  provider: string
  cumulative: string
  expires: number
  sig: string
  signer?: string
  [key: string]: unknown
}

/** @experimental Not covered by the 1.0 stability promise (TAP-22 payments / ServiceDirectory are not deployed); may change in a 1.x minor release. Voucher store. A store shared by several instances MUST implement advance() as one atomic statement. */
export interface VoucherStore {
  get(consumer: string, provider: string): Promise<VoucherRecord | null>
  set(consumer: string, provider: string, rec: VoucherRecord): Promise<void>
  all?(): Promise<VoucherRecord[]>
  /** Store `rec` only if it raises the counter; resolve to whether it did. */
  advance?(consumer: string, provider: string, rec: VoucherRecord): Promise<boolean>
}

/** @experimental Not covered by the 1.0 stability promise (TAP-22 payments / ServiceDirectory are not deployed); may change in a 1.x minor release. The default in-process store (lost on restart; one instance only). */
export declare function memoryStore(): Required<VoucherStore>

/** Context passed to every method handler. */
export interface MethodContext {
  /** @experimental Not covered by the 1.0 stability promise (TAP-22 payments / ServiceDirectory are not deployed); may change in a 1.x minor release. The paying consumer, or null for a free call. */
  consumer: string | null
  /** @experimental Not covered by the 1.0 stability promise (TAP-22 payments / ServiceDirectory are not deployed); may change in a 1.x minor release. */
  voucherSigner?: string
  /** @experimental Not covered by the 1.0 stability promise (TAP-22 payments / ServiceDirectory are not deployed); may change in a 1.x minor release. */
  cumulative?: unknown
  /** The block the answer is pinned to (0 without rpcUrls). */
  block: number
  manifest: Manifest
  method: ManifestMethod
  /** @experimental Not covered by the 1.0 stability promise (TAP-22 payments / ServiceDirectory are not deployed); may change in a 1.x minor release. Price in base units. */
  price: bigint
  clientIp: string
  [key: string]: unknown
}

/** A method handler: return a JSON-serialisable result, or throw an Error with a TAP-21 `code` (e.g. 'BAD_REQUEST'). */
export type MethodHandler = (params: Record<string, any>, ctx: MethodContext) => unknown | Promise<unknown>

export interface CreateProviderOptions {
  /** The TAP-20 manifest (validated; the object is kept by reference). */
  manifest: Manifest | Record<string, unknown>
  /** Private key of the manifest's delegated signer. */
  signerKey: string
  /** One handler per manifest method. */
  methods: Record<string, MethodHandler>
  rpcUrls?: string[]
  quorum?: number
  /** Timeout of one RPC request in ms. Renamed from `timeoutMs` in 1.0: passing `timeoutMs` throws INVALID_ARGUMENT. */
  rpcTimeoutMs?: number
  fetch?: FetchLike
  allowSingleNode?: boolean
  /** Development only: allows http:// endpoints, and priced methods whose payment.escrow is the zero address (paid calls are then refused) and
   *  on the in-memory meter without a warning. Only this option switches dev on: since 1.0 a manifest's own `dev` field
   *  does not. */
  dev?: boolean
  /** Accept http:// endpoints (local testing). Relaxes nothing else. */
  allowHttp?: boolean
  /** @experimental Not covered by the 1.0 stability promise (TAP-22 payments / ServiceDirectory are not deployed); may change in a 1.x minor release. */
  escrow?: string
  chainId?: number
  /** @experimental Not covered by the 1.0 stability promise (TAP-22 payments / ServiceDirectory are not deployed); may change in a 1.x minor release. */
  store?: VoucherStore
  /** @experimental Not covered by the 1.0 stability promise (TAP-22 payments / ServiceDirectory are not deployed); may change in a 1.x minor release. Say that a priced service on the in-memory store is intended (silences the warning). */
  allowMemoryStore?: boolean
  warn?: (...args: unknown[]) => void
  log?: (...args: unknown[]) => void
  bodyLimit?: number
  handlerTimeoutMs?: number
  requestTimeoutMs?: number
  headersTimeoutMs?: number
  /** @experimental Not covered by the 1.0 stability promise (TAP-22 payments / ServiceDirectory are not deployed); may change in a 1.x minor release. */
  minVoucherLifeS?: number
  /** false disables the built-in rate limiter. */
  rateLimit?: false | { windowMs?: number; free?: number; paid?: number; max?: number; ip?: number }
  /** Proxy header that carries the client IP (e.g. 'cf-connecting-ip'); unset, the socket peer is used. */
  clientIpHeader?: string
  /** @experimental Not covered by the 1.0 stability promise (TAP-22 payments / ServiceDirectory are not deployed); may change in a 1.x minor release. */
  escrowCacheMs?: number
  /** @experimental Not covered by the 1.0 stability promise (TAP-22 payments / ServiceDirectory are not deployed); may change in a 1.x minor release. */
  sessionCacheMs?: number
  blockCacheMs?: number
  /** @experimental Not covered by the 1.0 stability promise (TAP-22 payments / ServiceDirectory are not deployed); may change in a 1.x minor release. */
  contributionCacheMs?: number
  cacheMax?: number
  /** @experimental Not covered by the 1.0 stability promise (TAP-22 payments / ServiceDirectory are not deployed); may change in a 1.x minor release. */
  withdrawCloseS?: number
}

/** A Node http.Server (typed structurally so consumers need no @types/node). */
export interface ListeningServer {
  address(): unknown
  close(cb?: (err?: Error) => void): unknown
  [key: string]: any
}

/** @experimental Not covered by the 1.0 stability promise (TAP-22 payments / ServiceDirectory are not deployed); may change in a 1.x minor release. */
export interface Settlement extends VoucherRecord { deadline: number }

export interface Provider {
  /** Fetch-style entry point (Cloudflare Workers, Deno, Bun, Node 20+). */
  handleRequest(request: Request, ctx?: { clientIp?: string }): Promise<Response>
  /** Node only: start an http server (default port 0 = random, host 127.0.0.1). */
  listen(port?: number, host?: string): Promise<ListeningServer>
  close(): Promise<void>
  /** Node http request listener, for use with your own server. */
  handler(req: any, res: any): void
  /** Dispatch one parsed request body without HTTP (tests, custom transports). */
  invoke(body: unknown, opts?: { ip?: string; sentMethod?: string }): Promise<Record<string, unknown>>
  stats(): Record<string, unknown>
  /** @experimental Not covered by the 1.0 stability promise (TAP-22 payments / ServiceDirectory are not deployed); may change in a 1.x minor release. */
  pendingSettlements(): Promise<Settlement[]>
  /** @experimental Not covered by the 1.0 stability promise (TAP-22 payments / ServiceDirectory are not deployed); may change in a 1.x minor release. */
  dueSettlements(opts?: { marginS?: number }): Promise<Array<Settlement & { reason: 'deadline' | 'withdraw-requested' }>>
  /** @experimental Not covered by the 1.0 stability promise (TAP-22 payments / ServiceDirectory are not deployed); may change in a 1.x minor release. Build the escrow settle transaction for a voucher; send it with your own wallet. */
  settleTx(v: { consumer: string; provider: string; cumulative: string | bigint; expires: number | bigint; sig: string }): TxRequest
  /** @experimental Not covered by the 1.0 stability promise (TAP-22 payments / ServiceDirectory are not deployed); may change in a 1.x minor release. */
  contribution(): Promise<number | null>
  currentBlock(): Promise<number>
  manifest: Manifest
  container: string
  signer: string
  /** @experimental Not covered by the 1.0 stability promise (TAP-22 payments / ServiceDirectory are not deployed); may change in a 1.x minor release. */
  escrow: string | undefined
  chainId: number
  /** @experimental Not covered by the 1.0 stability promise (TAP-22 payments / ServiceDirectory are not deployed); may change in a 1.x minor release. */
  store: VoucherStore
  rpc: Rpc | null
  version: string
  readonly server: ListeningServer | null
}

export declare function createProvider(opts: CreateProviderOptions): Provider
