// Type declarations for @tapeapi/sdk (hand-written; the JavaScript in ../src is the source of truth).
// Shapes that the protocol leaves open (manifests, results, channel records) are typed loosely on purpose.
import type { Address, Hex, BigNumberish, FetchLike, TxRequest } from './common.js'
import type { Rpc } from './rpc.js'
import type { Manifest } from './manifest.js'
import type { TypedData } from './sig.js'

export type { Address, Hex, BigNumberish, FetchLike, TxRequest } from './common.js'
export type { Rpc, RpcOptions } from './rpc.js'
export type { Manifest, ManifestMethod } from './manifest.js'
export { TapeAPIError } from './errors.js'
export { createRpc } from './rpc.js'
export { RPC_DEFAULTS, rpcUrlsFor, operatorOf } from './rpc-defaults.js'
export type { RpcNode } from './rpc-defaults.js'
export { CHAINS, CHAIN_IDS, HOME_CHAIN_ID, IMPL_SLOT, chainById, chainByArea, chainByKey, parseTapeName, formatTapeName, isNameShaped } from './chains.js'
export type { TapeOutChain, ParsedTapeName } from './chains.js'
export { canonicalJSON, safeParseJSON } from './canon.js'
export { validateManifest, parseUnits, formatUnits, METHOD_NAME_RE, BEM_DECIMALS } from './manifest.js'
export { labelToBytes32 } from './abi.js'
export * as abi from './abi.js'
export * as sig from './sig.js'
export * as channel from './channel.js'
export * as group from './group.js'
export { deliverGroupUpdate, checkGroupInvites } from './group-delivery.js'
export type { GroupDelivery, GroupDeliveryResult, GroupInviteCheck, CursorStore, RelayCarrier, BusCarrier } from './group-delivery.js'
export * as tapesend from './tapesend.js'
export * as webmcp from './webmcp.js'
export * as mcp from './mcp.js'
export * as ai from './ai.js'

export declare const MAX_CONTRIBUTION_BPS: number
export declare const RECOMMENDED_CONTRIBUTION_BPS: number
/** BNB Smart Chain mainnet contract addresses (the defaults). */
export declare const MAINNET: {
  readonly chainId: 56
  readonly hub: Address
  readonly siteRegistry: Address
  readonly factory: Address
  readonly bem: Address
  readonly channelBus: Address
}
/** Nodes that serve eth_getLogs for reading ChannelBus; use with createRpc({ urls: BUS_RPC_URLS, quorum: 2, timeoutMs: 15000 }). */
export declare const BUS_RPC_URLS: readonly string[]
export declare const MANIFEST_PATH: string
export declare const MANIFEST_KEY: string
export declare const CHANNEL_KEYS_KEY: string
export declare const CHANNEL_KEYS_LIMIT: number
export declare const CHANNEL_ISSUED_SKEW_S: number
export declare const IDENTITY_CACHE_S: number
export declare const IDENTITY_CACHE_SIZE: number
export declare const MANIFEST_LIMIT: number
export declare const ENVELOPE_LIMIT: number
export declare const MANIFEST_TTL_MS: number
export declare const DEFAULT_MAX_SKEW_S: number
/** SiteRegistry key for a path (strips leading slashes). */
export declare function registryKey(path: string): string

export interface CreateTapeAPIOptions {
  /** JSON-RPC nodes of at least `quorum` distinct operators (see `operatorOf`; `rpcUrlsFor(56)` gives three).
   *  Without them every chain read throws RPC_UNAVAILABLE. */
  rpcUrls?: string[]
  /** How many node operators must agree on every read (default 2); URLs of one operator count once. */
  quorum?: number
  /** Development only: accept fewer nodes than `quorum`. */
  allowSingleNode?: boolean
  timeoutMs?: number
  fetch?: FetchLike
  /** Allow resolve({ dev }) and http:// endpoints. Does not relax checks on chain-sourced manifests. */
  dev?: boolean
  /** Accept http:// endpoints outside dev (tests only). */
  allowHttp?: boolean
  /** Maximum |envelope ts - local clock| in seconds (default 300). */
  maxSkewS?: number
  identityCacheS?: number
  identityCacheSize?: number
  /** Persist the highest channel-record `issued` seen per container across restarts. */
  channelRecordFloor?: { get(key: string): unknown; set(key: string, value: unknown): unknown }
  /** This client's chain (default 56). A chain in CHAINS brings its own hub, factory and siteRegistry. */
  chainId?: number
  /** Nodes for the other TapeOut chains, used when a target names one (a name with an area code, or { chainId }).
   *  Without an entry, that chain's SDK defaults (rpcUrlsFor) are used. */
  chains?: Record<number, { rpcUrls?: string[]; quorum?: number; timeoutMs?: number; allowSingleNode?: boolean; hub?: Address; factory?: Address; siteRegistry?: Address }>
  hub?: Address
  siteRegistry?: Address
  /** TapeOut processor factory; required with hub and siteRegistry on a chain not in CHAINS. */
  factory?: Address
  directory?: Address
  escrow?: Address
}

/** What api.resolve() accepts: a TapeOut name ('11.1013.tape' on BNB Smart Chain, '1.2.344.tape' on X Layer), a
 *  container address (this client's chain), a directory label, a { circuits, tokenId } pair (optionally with the chainId
 *  it is on), { chainId, container }, or (with dev: true) { dev: url | manifest }. */
export type ResolveTarget =
  | string
  | { circuits: Address; tokenId: BigNumberish; chainId?: number }
  | { chainId: number; container: Address }
  | { dev: string | Record<string, unknown> }

/** A service returned by api.resolve(): manifest verified against the chain and the holder's delegation. */
export interface ResolvedService {
  manifest: Manifest
  container: Address
  /** The chain the service lives on (its identity, manifest and delegation are read there). */
  chainId: number
  verified: { delegation: boolean; holder: Address | null; dev?: boolean; [key: string]: unknown }
  /** Contribution in basis points (0 for a free service). */
  contribution: number
  file: { size: unknown; sha256Hash: Hex; updatedAt: unknown } | null
  target: ResolveTarget
  fetchedAt: number
  /** Why the manifest's `ai` field was dropped (TAP-20 §3.9: an invalid field is refused, the rest of the manifest is kept). */
  aiProblems?: string[]
}

export interface CallOptions {
  payer?: Payer
  /** Idempotency key, 1..128 chars (default: a random UUID). */
  id?: string
  signal?: AbortSignal
  timeoutMs?: number
  manifestTtlMs?: number
  /** Highest price (base units) you consent to if the provider raised it. */
  maxPrice?: BigNumberish
}

/** A verified TAP-21 answer. `result` is the method's JSON result. */
export interface CallResult<T = any> {
  result: T
  verified: true
  ts: number
  block: unknown
  id: string
  sig: Hex
}

export interface QuorumOptions extends CallOptions {
  /** Independent providers that must agree (default 2; TAP-23 requires at least 2). */
  quorum?: number
  compare?: Record<string, unknown>
  onDissent?: 'reject' | 'quorum'
  allowSingleProvider?: boolean
}

export interface QuorumResult<T = any> {
  result: T
  agreed: Address[]
  disagreed: Address[]
  failed: unknown[]
  verified: true
  quorum: number
  responses: CallResult<T>[]
  groups: Array<{ result: T; containers: Address[] }>
}

export interface SignedVoucher { consumer: Address; provider: Address; cumulative: string; expires: number; sig: Hex; signer: Address }

export interface PayerOptions {
  consumer: Address
  /** Session private key (authorised on the escrow), or use signTypedData with a wallet. */
  sessionKey?: Hex
  signTypedData?: (typedData: TypedData) => Promise<Hex>
  /** Voucher lifetime in seconds (default 3600). */
  ttl?: number
  sessionExpiry?: number
  /** Persist cumulative counters (decimal strings); may be async. */
  store?: { get(key: string): unknown; set(key: string, value: string): unknown }
}

export interface Payer {
  readonly consumer: Address
  readonly signer: Address
  cumulativeOf(svc: ResolvedService): bigint
  inflightOf(svc: ResolvedService): number
  setCumulative(svc: ResolvedService, value: BigNumberish): Promise<void>
  resync(svc: ResolvedService, last: BigNumberish, evidence?: { voucher?: Record<string, unknown> }): Promise<bigint>
  reserve(svc: ResolvedService, price: BigNumberish): Promise<{ voucher: SignedVoucher; next: bigint; amount: bigint; commit(): Promise<void>; release(): void }>
  voucherFor(svc: ResolvedService, price: BigNumberish): Promise<SignedVoucher>
  [key: string]: unknown
}

type ProviderRef = Address | ResolvedService

/** Transaction builders: each returns a TxRequest for your own wallet to send; nothing is signed or sent. */
export interface TxBuilders {
  approve(opts: { amount: BigNumberish; token?: Address; spender?: ProviderRef }): TxRequest
  fund(provider: ProviderRef, amount: BigNumberish): TxRequest
  requestWithdraw(provider: ProviderRef, amount: BigNumberish): TxRequest
  cancelWithdraw(provider: ProviderRef): TxRequest
  withdraw(provider: ProviderRef): TxRequest
  authorizeSession(provider: ProviderRef, key: Address, expires: BigNumberish): TxRequest
  settle(voucher: { consumer: Address; provider: Address; cumulative: BigNumberish; expires: BigNumberish; sig: Hex }, svc?: ResolvedService): TxRequest
  setContribution(opts: { circuits: Address; tokenId: BigNumberish; bps: number; escrow?: Address }): TxRequest
  publishManifest(opts: { container: Address; manifest: string | Record<string, unknown>; contentType?: string }): { txs: TxRequest[]; key: string; size: number; sha256Hash: Hex }
  removeManifest(container: Address): TxRequest
  publishChannelKeys(opts: { container: Address; record: Record<string, unknown> }): { txs: TxRequest[]; key: string; size: number; sha256Hash: Hex }
  removeChannelKeys(container: Address): TxRequest
  register(opts: { circuits: Address; tokenId: BigNumberish; label?: string; manifestPath?: string; value?: BigNumberish }): TxRequest
}

/** A container's TAP-26 channel identity as read from chain (loose). */
export interface ChannelKeysRecord {
  container: Address
  chainId: number
  circuits: Address
  tokenId: string
  staticPublic: string
  x25519: string
  ed25519: string
  issued: number
  expires: number
  holder: Address
  keys: string
  inbox: { room: string; relays: unknown[]; bus?: unknown }
  [key: string]: unknown
}

/** Chain reads (quorum RPC). Return values are decoded ABI values. */
export interface ChainReads {
  accountOf(circuits: Address, tokenId: BigNumberish): Promise<Address>
  cpuAt(processor: BigNumberish): Promise<Address>
  isCPU(circuits: Address): Promise<boolean>
  channelKeys(container: Address, opts?: { fresh?: boolean }): Promise<ChannelKeysRecord>
  tapeSendKey(target: Address | { circuits: Address; tokenId: BigNumberish }): Promise<Record<string, unknown>>
  ownerOf(circuits: Address, tokenId: BigNumberish): Promise<Address>
  /** ERC-6551 token() of a container on this chain. */
  tokenOf(container: Address): Promise<{ circuits: Address; tokenId: bigint }>
  resolve(label: string): Promise<Address>
  serviceOf(container: Address): Promise<any>
  readFile(container: Address, path: string): Promise<any>
  fileInfo(container: Address, path: string): Promise<any>
  escrow: {
    channelOf(consumer: Address, provider: ProviderRef): Promise<any>
    claimedOf(consumer: Address, provider: ProviderRef): Promise<bigint>
    sessionExpiry(consumer: Address, provider: ProviderRef, key: Address): Promise<bigint>
    pendingWithdraw(consumer: Address, provider: ProviderRef): Promise<any>
    contributionOf(provider: Address, escrow?: Address): Promise<any>
    treasury(escrow?: Address): Promise<Address>
  }
}

export interface TapeAPI {
  /** Resolve and verify a service: manifest bytes checked on chain, identity re-derived, delegation verified. */
  resolve(target: ResolveTarget): Promise<ResolvedService>
  /** Re-read a resolved service from its source and update it in place. */
  refresh(svc: ResolvedService): Promise<ResolvedService>
  /** Consent to the service's current prices (all methods, or one). Returns the accepted price map (base units). */
  acceptPrice(svc: ResolvedService, method?: string): Record<string, bigint>
  acceptedPrice(svc: ResolvedService, method: string): bigint | undefined
  /** Call one method; the answer's signature is verified against the delegated signer. */
  call<T = any>(svc: ResolvedService, method: string, params?: Record<string, unknown>, opts?: CallOptions): Promise<CallResult<T>>
  /** Call several independent providers and require `quorum` identical verified answers (TAP-23). */
  callQuorum<T = any>(services: ResolvedService[], method: string, params?: Record<string, unknown>, opts?: QuorumOptions): Promise<QuorumResult<T>>
  /** A voucher signer for paid calls (TAP-22). */
  payer(opts: PayerOptions): Payer
  tx: TxBuilders
  /** The quorum RPC client, or null when no rpcUrls were given. */
  rpc: Rpc | null
  chain: ChainReads
  chainId: number
  groupVerifier(): (member: Record<string, unknown>, opts?: { fresh?: boolean }) => Promise<boolean>
  addresses: { hub: Address; siteRegistry: Address; directory: Address | undefined; escrow: Address | undefined }
  randomPrivateKey(): Hex
  /** The client for another TapeOut chain (this client for its own chain). */
  forChain(chainId: number): TapeAPI
  /** Which supported chain a container address lives on, or null. */
  chainOfContainer(container: Address): Promise<number | null>
}

export declare function createTapeAPI(opts?: CreateTapeAPIOptions): TapeAPI
