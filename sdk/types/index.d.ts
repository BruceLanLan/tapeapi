// Type declarations for @tapeapi/sdk (hand-written; the JavaScript in ../src is the source of truth).
// Shapes that the protocol leaves open (manifests, results, channel records) are typed loosely on purpose.
//
// Stability (1.0): every declaration is Stable (no breaking change within 1.x) unless tagged @experimental (payments,
// ServiceDirectory, bus-privacy: may change in a 1.x minor release) or @internal (not part of the API). See docs/guides/upgrade-1.0.md.
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
export { CHAINS, CHAIN_IDS, HOME_CHAIN_ID, IMPL_SLOT, chainById, chainByArea, chainByKey, parseTapeName, formatTapeName, isNameShaped, parseTapeInput, MAX_TOKEN_ID, MAX_PROCESSOR } from './chains.js'
export type { TapeOutChain, ParsedTapeName } from './chains.js'
/** @experimental (1.5) TAP-10 §13.8 messaging constants per chain, and the §12.1 endpoint chainId bound (2^53 − 1). */
export { TAP10_SEALS, TAP10_MAX_CHAIN_ID } from './chains.js'
/** @experimental (TAPI-22 §3.5) Escrow token labels and the (empty) audited escrow list; may change in a 1.x minor release. */
export { PAYMENT_TOKENS, AUDITED_ESCROWS } from './chains.js'
export type { Tap10Seals } from './chains.js'
export { canonicalJSON, safeParseJSON } from './canon.js'
export { validateManifest, parseUnits, formatUnits, METHOD_NAME_RE, BEM_DECIMALS } from './manifest.js'
/** @experimental ServiceDirectory labels (not deployed); may change in a 1.x minor release. */
export { labelToBytes32 } from './abi.js'
export * as abi from './abi.js'
export * as sig from './sig.js'
export * as channel from './channel.js'
/** @experimental ChannelBus read privacy: every option, default, and stats().privacy may change in a 1.x minor release. */
export * as busPrivacy from './bus-privacy.js'
export * as group from './group.js'
export { deliverGroupUpdate, checkGroupInvites } from './group-delivery.js'
export type { GroupDelivery, GroupDeliveryResult, GroupInviteCheck, CursorStore, RelayCarrier, BusCarrier } from './group-delivery.js'
export * as tapesend from './tapesend.js'
export * as webmcp from './webmcp.js'
export * as mcp from './mcp.js'
export * as ai from './ai.js'
/** @experimental security 1.1: local container derivation, ContradictionRecord v1, random second opinions. */
export * as security from './security.js'
/** @experimental security 1.2: RLP and Merkle-Patricia proof checks (EIP-1186), and the storage slots resolve can prove. */
export * as proof from './proof.js'

/** @experimental Not covered by the 1.0 stability promise (TAPI-22 payments / ServiceDirectory are not deployed); may change in a 1.x minor release. */
export declare const MAX_CONTRIBUTION_BPS: number
/** @experimental Not covered by the 1.0 stability promise (TAPI-22 payments / ServiceDirectory are not deployed); may change in a 1.x minor release. */
export declare const DEFAULT_CONTRIBUTION_BPS: number
/** @experimental Not covered by the 1.0 stability promise (TAPI-22 payments / ServiceDirectory are not deployed); may change in a 1.x minor release. */
export declare const RECOMMENDED_CONTRIBUTION_BPS: number
/** BNB Smart Chain mainnet contract addresses (the defaults). */
export declare const MAINNET: {
  readonly chainId: 56
  readonly hub: Address
  readonly siteRegistry: Address
  readonly factory: Address
  /** @experimental Not covered by the 1.0 stability promise (TAPI-22 payments / ServiceDirectory are not deployed); may change in a 1.x minor release. */
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
/** @experimental (1.4) The reread age of a kept service under conform: 'tap10' (TAP-11 §7.1, TAP-10 §11): 60 s. */
export declare const CONFORM_TTL_MS: number
export declare const DEFAULT_MAX_SKEW_S: number
/** SiteRegistry key for a path (strips leading slashes). */
export declare function registryKey(path: string): string

export interface CreateTapeAPIOptions {
  /** JSON-RPC nodes of at least `quorum` distinct operators (see `operatorOf`; `rpcUrlsFor(56)` gives three).
   *  Without them every chain read throws INVALID_ARGUMENT (a configuration mistake, not an outage). */
  rpcUrls?: string[]
  /** How many node operators must agree on every read (default 2); URLs of one operator count once. */
  quorum?: number
  /** Development only: accept fewer nodes than `quorum`. */
  allowSingleNode?: boolean
  /** Silence the rpc "no spare" notice, also on other chains unless `chains[id].quiet` is set. */
  quiet?: boolean
  /** Timeout of one RPC request in ms (default 8000). Renamed from `timeoutMs` in 1.0: passing `timeoutMs` throws
   *  INVALID_ARGUMENT (api.call keeps its own per-call `timeoutMs`). */
  rpcTimeoutMs?: number
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
  /** @experimental (1.5) Only with conform: 'tap10': where the sticky TAP-10 §13.8 statuses of the messaging path are kept,
   *  key `<chainId>:<hub, lowercase>`, value `{ circuitsChangedAt: number | null; factorySealSeenAt: number | null;
   *  factorySealLost: boolean }`. get/set may be async. Default: a Map of this client (and its forChain sub-clients). */
  sealStatusStore?: { get(key: string): unknown; set(key: string, value: unknown): unknown }
  /** This client's chain (default 56). A chain in CHAINS brings its own hub, factory and siteRegistry. */
  chainId?: number
  /** Nodes for the other TapeOut chains, used when a target names one (a name with an area code, or { chainId }).
   *  Without an entry, that chain's SDK defaults (rpcUrlsFor) are used. */
  chains?: Record<number, { rpcUrls?: string[]; quorum?: number; rpcTimeoutMs?: number; allowSingleNode?: boolean; quiet?: boolean; hub?: Address; factory?: Address; siteRegistry?: Address; opener?: Address; binding?: Address; pin?: CreateTapeAPIOptions['pin'] }>
  hub?: Address
  siteRegistry?: Address
  /** TapeOut processor factory; required with hub and siteRegistry on a chain not in CHAINS. */
  factory?: Address
  /** @experimental (1.4) TAP-10 container opener (accountOf, isOpened), read by `conform` and `siteStatus`. Default: the chain's. */
  opener?: Address
  /** @experimental (1.4) TAP-10 payment contract DomainBinding (isLive, isContainerLive), read by `conform` and `siteStatus`. Default: the chain's. */
  binding?: Address
  /** @experimental (1.4) The TAP-10 conformance mode (TAP-10 v1.1, the resolution path): resolve as TAP-10 §3-§7 and TAP-11
   *  §2.2 say, at one TAP-10 pinned block (implies `pin: 'tap10'`; another explicit `pin` is INVALID_ARGUMENT). Accepts the
   *  TAP-10 §3.4 input forms (display label, tape:// URL, processor contract#ID) and refuses directory labels; reads the
   *  container from the opener, `isOpened`, and activation (`isLive`, `isContainerLive`); refuses an unaccepted SiteRegistry
   *  or DomainBinding implementation (store-changed, fail-closed). Every error carries the TAP-10 / TAP-11 outcome name in
   *  `data.status`; `not-opened` and `unpaid` are `SITE_STATUS`. Messaging reads (channelKeys, tapeSendKey) are never
   *  gated by activation or opening (TAP-10 §12.2). Since 1.5 they also read the TAP-10 way: a fresh TAP-10 pinned block,
   *  strict agreement on every read and on `eth_chainId`, the container from the opener; tapeSendKey checks the hub
   *  (`hub-changed`, `circuits-changed`, TAP-10 §13.8) and the key (`hub-mismatch`, `no-key`, `key-stale`, `bad-key`,
   *  §14.4 steps 1-3); channelKeys needs both site-store implementations accepted (`store-changed`) and refuses a byte
   *  order mark. Only the hub, factory and opener TAP-10 lists for the chain are accepted (`hub`, `factory`, `opener`
   *  set to anything else: INVALID_ARGUMENT). Input that may belong to another chain is `unsupported`, as in resolve.
   *  Since 1.5 the processor number of a container address or processor contract#ID is found (TAP-10 §4.3: a snapshot
   *  shipped with the SDK, checked by one `cpuAt` at the pinned block, then a capped, resumable `cpuAt` scan), and input
   *  without chain information is searched on every chain with `allChains`. Since 1.5.0 resolve checks `eth_chainId` and reads `ownerOf`
   *  and a contract holder's EIP-1271 calls (`eth_getCode`, `isValidSignature`; delegation and contentSig) under strict
   *  agreement (TAP-11 §2.2); its other reads, and `siteStatus`, keep default agreement. */
  conform?: 'tap10' | false | null
  /** @experimental (1.5) Resolve input without chain information (a container address or a processor contract#ID
   *  string, TAP-10 §4.1) on EVERY TapeOut chain, each at its own TAP-10 pinned block: more than one chain resolving it is
   *  INVALID_ARGUMENT with `data.status` 'ambiguous' and `data.candidates`; a chain that cannot be read (or whose site
   *  contracts are `store-changed`) is reported with its own status instead of a guess or `not-tapeout`; every result and
   *  such error carries `chains` / `data.chains`, what each chain said. This sends reads to the other chains' nodes
   *  (`chains[id].rpcUrls`, or the SDK defaults for that chain), so it is off unless you pass `true`.
   *  Applies to the TAP-10 path only: `resolve` under `conform: 'tap10'`, and `siteStatus` in any mode; passed on by
   *  `forChain`. Only `true` turns it on; any other value is ignored (1.4 ignored the option). Off: a container address is
   *  resolved on this client's chain when it is a container of this chain and is `unsupported` otherwise (never
   *  `not-tapeout`); under `conform: 'tap10'` a processor contract#ID string is `unsupported` before any request (TAP-10
   *  resolves it only when exactly one chain does), while `siteStatus` on a default client resolves it on this client's
   *  chain as 1.4 did. `{ circuits, tokenId, chainId? }` names its chain (this client's when `chainId` is left out) and
   *  `{ chainId, container }` names its own; neither is searched. `{ container }` without `chainId` is an input error. */
  allChains?: boolean | null
  /** @experimental Not covered by the 1.0 stability promise (TAPI-22 payments / ServiceDirectory are not deployed); may change in a 1.x minor release. */
  directory?: Address
  /** @experimental Not covered by the 1.0 stability promise (TAPI-22 payments / ServiceDirectory are not deployed); may change in a 1.x minor release. */
  escrow?: Address
  /** @experimental (TAPI-22 §3.5) Escrows, besides the audited deployments in AUDITED_ESCROWS (empty today), that
   *  `tx.approve` and `tx.fund` may build for. Default none; `escrow` is not added. Add only escrows you trust: approve
   *  lets an escrow pull tokens. `tx.fund` is built only if the escrow also holds BEM. */
  allowEscrows?: Address[]
  /** @experimental (security 1.1) A function returning Unix seconds; every `now` of this client reads it (default Date.now). */
  clock?: () => number
  /** @experimental (security 1.1) Pin every read of one resolution to one block that nodes of `quorum` operators confirm
   *  and that is at most `maxAgeS` old (by its timestamp against `clock`). `true` uses the chain's settings (chains.js
   *  `finality`: BSC 'finalized', L2 'safe'; `maxPinAgeS`). Reads go by EIP-1898 blockHash (`by: 'hash'`, default) or
   *  block number. Costs one more round per resolution (two when the nodes' tagged blocks differ), unless `cacheS`
   *  reuses a pin. Default: unpinned (chains.js `pin: 'latest'`). A stale block is RPC_STALE.
   *  `'tap10'` (@experimental, 1.4): TAP-10 §5.3 instead: the second highest operator head minus 2, stale by block lag only
   *  (chains.js `tap10MaxPinLag`: BSC 400, Base 150, X Layer 300; RPC_STALE with data.status 'stale-block'), reads by
   *  the block's hash. */
  pin?: boolean | 'latest' | 'tap10' | { tag?: 'finalized' | 'safe' | 'latest'; maxAgeS?: number; by?: 'hash' | 'number'; cacheS?: number }
  /** @experimental (security 1.1) Identity-root sentinel: compare the DeWebHub's and the SiteRegistry's ERC-1967
   *  implementations with chains.js `expectedImpl`, and re-derive the container locally (ERC-6551). 'warn' (default)
   *  reports in `svc.warnings` and `onWarning`; 'strict' refuses (CONTRACT_UNKNOWN, MANIFEST_INVALID); 'off' skips.
   *  It notices an upgrade; it cannot prevent one. */
  sentinel?: 'warn' | 'strict' | 'off'
  /** @experimental (security 1.1) Refuse a manifest without a valid holder `contentSig` (TAPI-20 §3.10) (default false). */
  requireContentSig?: boolean
  /** @experimental (security 1.1) Refuse a delegation whose signed `expires` is below the highest seen for the same
   *  container, holder and signer (a delegation to another signer starts its own floor). `true` keeps it in memory; a
   *  { get, set, delete? } store keeps it across restarts (default off). Limits: it cannot refuse an older holder-signed
   *  delegation to an earlier signer put back by whoever can write the site; a holder who shortens `expires` for the same
   *  signer is refused until `api.clearDelegationFloor`. */
  delegationFloor?: boolean | { get(key: string): unknown; set(key: string, value: unknown): unknown; delete?(key: string): unknown }
  /** @experimental (security 1.1) Receives each warning of a resolution (default: console.warn once per warning). */
  onWarning?: (warning: ResolveWarning) => void
  /** @experimental (security 1.2) Merkle proof mode, only with `pin` (without it: INVALID_ARGUMENT). cpuAt, isCPU, ownerOf
   *  and fileInfo are also proven by eth_getProof (from any node) against the stateRoot of the pinned block, which nodes
   *  of `quorum` operators confirmed, and compared with the quorum's eth_call answers; the manifest bytes then hash to the
   *  proven sha256Hash. A verified proof that contradicts the quorum's answer is refused in both modes (PROOF_INVALID).
   *  When no verified proof can be had, `true` warns (PROOF_UNAVAILABLE, PROOF_INVALID in `svc.warnings`) and keeps the
   *  quorum reads (detection only), and 'strict' refuses with those codes. Not proven: contentSig, EIP-1271
   *  isValidSignature, accountOf (the sentinel re-derives the container locally) and the directory's serviceOf. A dev
   *  target is not pinned: its `svc.proofs` is undefined. It rests on the stateRoot being confirmed by independent operators: it does not
   *  stop an upgrade of a TapeOut contract (real state) or operators that all collude on the block header. Default off. */
  proofs?: boolean | 'strict'
}

/** @experimental (security 1.2) One read of a resolution under the proof mode. */
export interface ProofEntry {
  read: 'fileInfo' | 'cpuAt' | 'isCPU' | 'ownerOf'
  /** The contract whose storage was proven. */
  address: Address
  /** The host of the node that served the proof. */
  node?: string
  /** Why the read was not proven (unavailable / invalid only). */
  reason?: string
  [key: string]: unknown
}

/** @experimental (security 1.1) A finding that did not stop a resolution. */
export interface ResolveWarning {
  code: 'IMPL_UNKNOWN' | 'IMPL_UNREAD' | 'CONTAINER_MISMATCH' | 'CONTENT_SIG_INVALID' | 'CONTENT_SIG_UNCHECKED' | 'PROOF_UNAVAILABLE' | 'PROOF_INVALID' | string
  message: string
  [key: string]: unknown
}

/** What api.resolve() accepts: a TapeOut name ('11.1013.tape' on BNB Smart Chain, '1.2.344.tape' on X Layer), a
 *  container address (this client's chain), a directory label, a { circuits, tokenId } pair (optionally with the chainId
 *  it is on), { chainId, container }, or (with dev: true) { dev: url | manifest }. */
export type ResolveTarget =
  | string
  | { circuits: Address; tokenId: BigNumberish; chainId?: number }
  | { chainId: number; container: Address }
  | { dev: string | Record<string, unknown> }

/** @experimental (1.4) The TAP-10 site status of a target (api.siteStatus), and the identity behind it. */
export interface SiteStatus {
  /** The TAP-10 version this follows. */
  version: '1.1'
  status: 'ok' | 'unpaid' | 'not-opened' | 'store-changed' | 'no-such-cpu' | 'no-such-token' | 'not-tapeout'
  chainId: number
  /** The on-chain name; null when identity stopped before the processor number was known (for example `not-tapeout`). */
  name: string | null
  processor: string | null
  tokenId: string | null
  /** The processor contract. */
  circuits: Address | null
  /** Derived by the container opener (TAP-10 §4.2). */
  container: Address | null
  holder: Address | null
  opened: boolean | null
  /** TAP-10 §6.3, both reads made for every input since 1.5. A revert counts as false and is flagged. */
  activation: { live: boolean; isLive: boolean; isContainerLive: boolean; isLiveReverted?: true; isContainerLiveReverted?: true } | null
  /** The SiteRegistry and DomainBinding implementations at the pinned block (TAP-10 §6.1). */
  implementations: Array<{ role: 'siteRegistry' | 'binding'; proxy: Address; implementation: Address; accepted: boolean }> | null
  pinned: { number: number; hash: Hex; lag: number; maxLag: number }
  /** @experimental (1.5) Only for input searched on every chain (`allChains`): what each chain said, this client's chain
   *  first. `status` is a site status, an identity outcome, or the status of a read that failed ('unavailable',
   *  'stale-block', 'wrong-chain'). The fields above are the chosen chain's. */
  chains?: Array<{ chainId: number; status: string }>
  /** @experimental (1.5) Only with `allChains`, when a processor contract#ID resolved on one chain while the chain whose
   *  status is returned could not be decided (here: `store-changed`): the chain(s) that resolved it. */
  candidates?: Array<{ chainId: number; name: string | null; processor: string | null; tokenId: string | null; circuits: Address | null; container: Address | null; status: string; warnings?: Array<{ code: string; message: string }> }>
}

/** A service returned by api.resolve(): manifest verified against the chain and the holder's delegation. */
export interface ResolvedService {
  manifest: Manifest
  container: Address
  /** The chain the service lives on (its identity, manifest and delegation are read there). */
  chainId: number
  verified: { delegation: boolean; holder: Address | null; dev?: boolean; [key: string]: unknown }
  /** @experimental Not covered by the 1.0 stability promise (TAPI-22 payments / ServiceDirectory are not deployed); may change in a 1.x minor release. Contribution in basis points (0 for a free service). */
  contribution: number
  file: { size: unknown; sha256Hash: Hex; updatedAt: unknown } | null
  target: ResolveTarget
  fetchedAt: number
  /** Why the manifest's `ai` field was dropped (TAPI-20 §3.9: an invalid field is refused, the rest of the manifest is kept). */
  aiProblems?: string[]
  /** @experimental (security 1.1) The block every read of this resolution was made at (only with `pin`). `mode`, `lag`
   *  and `maxLag` with pin: 'tap10' or conform: 'tap10'. */
  pinned?: { number: number; hash: Hex; timestamp: number; tag: string; by: 'hash' | 'number'; mode?: 'tap10'; lag?: number; maxLag?: number }
  /** @experimental (1.4) What the TAP-10 conformance mode resolved (only with conform: 'tap10'). */
  conform?: Omit<SiteStatus, 'status'> & { status: 'resolved'; site: 'ok'; derivation?: 'match' | 'mismatch' }
  /** @experimental (security 1.1) What the identity-root sentinel saw (absent when it did not run). */
  sentinel?: {
    mode: 'warn' | 'strict'
    implementations: Array<{ role: string; proxy: Address; implementation: Address; expected: boolean }> | null
    container: 'match' | 'mismatch' | 'unchecked'
  }
  /** @experimental (security 1.1) Present when the manifest carries a contentSig or the client requires one.
   *  `checked: false`: an error prevented the check (warning CONTENT_SIG_UNCHECKED; only without requireContentSig). */
  contentSig?: { valid: boolean; checked?: false }
  /** @experimental (security 1.2) What the proof mode proved, against which block and stateRoot (only with `proofs`).
   *  `invalid`: reads for which every node that served a proof served one that does not verify (only with proofs: true;
   *  'strict' throws PROOF_INVALID). A proof that contradicts the quorum is never listed: it is thrown in both modes.
   *  Undefined for a dev target, which is not pinned. */
  proofs?: { mode: 'warn' | 'strict'; block: number; stateRoot: Hex | null; verified: ProofEntry[]; unavailable: ProofEntry[]; invalid: ProofEntry[] }
  /** @experimental (security 1.1) Findings that did not stop the resolution (absent when there were none). */
  warnings?: ResolveWarning[]
}

export interface CallOptions {
  /** @experimental Not covered by the 1.0 stability promise (TAPI-22 payments / ServiceDirectory are not deployed); may change in a 1.x minor release. */
  payer?: Payer
  /** Idempotency key, 1..128 chars (default: a random UUID). */
  id?: string
  signal?: AbortSignal
  timeoutMs?: number
  manifestTtlMs?: number
  /** @experimental Not covered by the 1.0 stability promise (TAPI-22 payments / ServiceDirectory are not deployed); may change in a 1.x minor release. Highest price (base units) you consent to if the provider raised it. */
  maxPrice?: BigNumberish
}

/** A verified TAPI-21 answer. `result` is the method's JSON result. */
export interface CallResult<T = any> {
  result: T
  verified: true
  ts: number
  block: unknown
  id: string
  sig: Hex
}

export interface QuorumOptions extends CallOptions {
  /** Independent providers that must agree (default 2; TAPI-23 requires at least 2). */
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

/** @experimental (TAPI-22 §3.5) An escrow's token as the SDK reads it: `label` from PAYMENT_TOKENS (null when the
 *  SDK does not know the token; never the token's own name()), `display` the label and the address. */
export interface PaymentToken {
  readonly escrow: Address
  readonly token: Address
  readonly decimals: number
  readonly label: string | null
  readonly display: string
}
/** @experimental (TAPI-22 §3.5) An escrow amount in whole tokens with the token's label and address; `token` from
 *  `api.chain.escrow.paymentToken()` (decimals are never assumed). */
export declare function formatPaymentAmount(amount: BigNumberish, token: PaymentToken): string

/** @experimental Not covered by the 1.0 stability promise (TAPI-22 payments / ServiceDirectory are not deployed); may change in a 1.x minor release. */
export interface SignedVoucher { consumer: Address; provider: Address; cumulative: string; expires: number; sig: Hex; signer: Address }

/** @experimental Not covered by the 1.0 stability promise (TAPI-22 payments / ServiceDirectory are not deployed); may change in a 1.x minor release. */
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

/** @experimental Not covered by the 1.0 stability promise (TAPI-22 payments / ServiceDirectory are not deployed); may change in a 1.x minor release. */
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
  /** @experimental Not covered by the 1.0 stability promise (TAPI-22 payments / ServiceDirectory are not deployed); may change in a 1.x minor release.
   *  Async since escrow v3: built only for an escrow on AUDITED_ESCROWS (empty) or `allowEscrows` (else INVALID_ARGUMENT,
   *  `data.reason` 'escrow-not-allowed'); the token approved is the escrow's own token(), read on chain. `token`, when
   *  given, is the token you expect (UNSUPPORTED_PAYMENT_TOKEN 'token-mismatch' otherwise); without it, or for a
   *  service's prices, the token must be BEM ('not-bem'). */
  approve(opts: { amount: BigNumberish; token?: Address; spender?: ProviderRef }): Promise<TxRequest>
  /** @experimental Not covered by the 1.0 stability promise (TAPI-22 payments / ServiceDirectory are not deployed); may change in a 1.x minor release.
   *  Async since escrow v3, with the same allow-list and token read as `approve`, but stricter: an escrow that holds
   *  anything but BEM is always refused (UNSUPPORTED_PAYMENT_TOKEN, `data.reason` 'not-bem'), whatever `token` you name
   *  and even if it is in `allowEscrows`. The escrow contract itself takes any admitted token; the manifest's pricing
   *  in more than one token is not yet specified, so the SDK does not build it. `token`, when given, must be the
   *  escrow's token ('token-mismatch' otherwise). */
  fund(provider: ProviderRef, amount: BigNumberish, opts?: { token?: Address }): Promise<TxRequest>
  /** @experimental Not covered by the 1.0 stability promise (TAPI-22 payments / ServiceDirectory are not deployed); may change in a 1.x minor release. */
  requestWithdraw(provider: ProviderRef, amount: BigNumberish): TxRequest
  /** @experimental Not covered by the 1.0 stability promise (TAPI-22 payments / ServiceDirectory are not deployed); may change in a 1.x minor release. */
  cancelWithdraw(provider: ProviderRef): TxRequest
  /** @experimental Not covered by the 1.0 stability promise (TAPI-22 payments / ServiceDirectory are not deployed); may change in a 1.x minor release. */
  withdraw(provider: ProviderRef): TxRequest
  /** @experimental Not covered by the 1.0 stability promise (TAPI-22 payments / ServiceDirectory are not deployed); may change in a 1.x minor release. */
  authorizeSession(provider: ProviderRef, key: Address, expires: BigNumberish): TxRequest
  /** @experimental Not covered by the 1.0 stability promise (TAPI-22 payments / ServiceDirectory are not deployed); may change in a 1.x minor release. */
  settle(voucher: { consumer: Address; provider: Address; cumulative: BigNumberish; expires: BigNumberish; sig: Hex }, svc?: ResolvedService): TxRequest
  /** @experimental Wrap native BNB: `wbnb.deposit()` with `value` = amount. `wbnb` is required (the SDK ships no wrapper
   *  address). No gas field: the wallet estimates it. */
  wrapNative(opts: { wbnb: Address; amount: BigNumberish }): TxRequest
  /** @experimental Escrow v3 (not deployed): pay the accrued contributions to the current treasury; anyone may send it. */
  claimTreasury(escrow?: Address | ResolvedService): TxRequest
  /** @experimental Not covered by the 1.0 stability promise (TAPI-22 payments / ServiceDirectory are not deployed); may change in a 1.x minor release. */
  setContribution(opts: { circuits: Address; tokenId: BigNumberish; bps: number; escrow?: Address }): TxRequest
  publishManifest(opts: { container: Address; manifest: string | Record<string, unknown>; contentType?: string }): { txs: TxRequest[]; key: string; size: number; sha256Hash: Hex }
  removeManifest(container: Address): TxRequest
  publishChannelKeys(opts: { container: Address; record: Record<string, unknown> }): { txs: TxRequest[]; key: string; size: number; sha256Hash: Hex }
  removeChannelKeys(container: Address): TxRequest
  /** @experimental Not covered by the 1.0 stability promise (TAPI-22 payments / ServiceDirectory are not deployed); may change in a 1.x minor release. */
  register(opts: { circuits: Address; tokenId: BigNumberish; label?: string; manifestPath?: string; value?: BigNumberish }): TxRequest
}

/** A container's TAPI-26 channel identity as read from chain (loose). */
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
  /** @experimental (1.5) Only with conform: 'tap10': how the record was read (the private-channels draft §3.3). From the
   *  identity cache, `pinned` is the block of the read that filled it; `{ fresh: true }` reads again. */
  tap10?: Tap10MessagingRead & { implementations: Array<{ role: 'siteRegistry' | 'binding'; proxy: Address; implementation: Address | null; accepted: boolean }> }
  [key: string]: unknown
}

/** @experimental (1.5) Common part of what the conformance mode's messaging reads report. */
export interface Tap10MessagingRead {
  version: '1.1'
  status: 'ok'
  /** The fresh TAP-10 pinned block every read was made at (by its hash). */
  pinned: { number: number; hash: Hex; lag: number; maxLag: number }
}

/** A container's TapeSend (TAP-10) key as the hub serves it (TAPI-26 §3.1 fallback; loose). */
export interface TapeSendKeyRecord {
  container: Address
  chainId: number
  circuits: Address
  tokenId: string
  /** The X25519 public key, 0x + 64 hex. */
  staticPublic: string
  keyIndex: number
  version: number
  holder: Address
  opened: boolean
  /** The receiving-chains bitmap in binary (TAP-10 §14.3): bit 0 BNB Smart Chain, 1 Base, 2 X Layer. */
  chainsBitmap: string
  /** @experimental (1.5) Only with conform: 'tap10' (TAP-10 §12.2, §13.8, §14.4 steps 1-3). */
  tap10?: Tap10MessagingRead & {
    /** uint32(0) ‖ uint64(chainId) ‖ container, hex. */
    endpoint: Hex
    hub: { implementation: Address | null; accepted: true }
    circuits: 'ok'
    /** §13.8: read, reported, never required. `factoryLost`: this client saw the factory seal in effect, then not. */
    seal: { factory: boolean; hub: boolean; factoryLost?: true }
  }
  [key: string]: unknown
}

/** Chain reads (quorum RPC). Return values are decoded ABI values. */
export interface ChainReads {
  accountOf(circuits: Address, tokenId: BigNumberish): Promise<Address>
  cpuAt(processor: BigNumberish): Promise<Address>
  isCPU(circuits: Address): Promise<boolean>
  channelKeys(container: Address, opts?: { fresh?: boolean }): Promise<ChannelKeysRecord>
  tapeSendKey(target: Address | { circuits: Address; tokenId: BigNumberish }): Promise<TapeSendKeyRecord>
  ownerOf(circuits: Address, tokenId: BigNumberish): Promise<Address>
  /** ERC-6551 token() of a container on this chain; tokenId is a decimal string (1.0: was a bigint). */
  tokenOf(container: Address): Promise<{ circuits: Address; tokenId: string }>
  /** @experimental Not covered by the 1.0 stability promise (TAPI-22 payments / ServiceDirectory are not deployed); may change in a 1.x minor release. */
  resolve(label: string): Promise<Address>
  /** @experimental Not covered by the 1.0 stability promise (TAPI-22 payments / ServiceDirectory are not deployed); may change in a 1.x minor release. */
  serviceOf(container: Address): Promise<any>
  readFile(container: Address, path: string): Promise<any>
  fileInfo(container: Address, path: string): Promise<any>
  /** @experimental Not covered by the 1.0 stability promise (TAPI-22 payments / ServiceDirectory are not deployed); may change in a 1.x minor release. */
  escrow: {
    channelOf(consumer: Address, provider: ProviderRef): Promise<any>
    claimedOf(consumer: Address, provider: ProviderRef): Promise<bigint>
    sessionExpiry(consumer: Address, provider: ProviderRef, key: Address): Promise<bigint>
    pendingWithdraw(consumer: Address, provider: ProviderRef): Promise<any>
    contributionOf(provider: Address, escrow?: Address): Promise<any>
    treasury(escrow?: Address): Promise<Address>
    /** Escrow v3: the instance's immutable token (an address or a resolved service; the configured escrow by default). */
    token(escrow?: Address | ResolvedService): Promise<Address>
    /** Escrow v3: what settlements have accrued to the treasury role and not yet been claimed (token base units). */
    treasuryAccrued(escrow?: Address | ResolvedService): Promise<bigint>
    /** The escrow's token and its decimals, both read on chain under strict agreement and cached per escrow; never
     *  assumed. UNSUPPORTED_PAYMENT_TOKEN (`data.reason`) when the escrow answers no token(), the token no valid
     *  decimals(), or decimals outside 8..18. */
    paymentToken(escrow?: Address | ResolvedService): Promise<PaymentToken>
    /** Read-only: one provider's contributionOf on each escrow instance (default: this client's allowed escrows), and a
     *  `warning` when they differ. A failed read is a reading with `bps: null` and the error code. */
    contributions(provider: Address, escrows?: Address[]): Promise<{ provider: Address; readings: Array<{ escrow: Address; bps: number | null; error?: string }>; consistent: boolean; warning: string | null }>
  }
}

export interface TapeAPI {
  /** Resolve and verify a service: manifest bytes checked on chain, identity re-derived, delegation verified. */
  resolve(target: ResolveTarget): Promise<ResolvedService>
  /** Re-read a resolved service from its source and update it in place. */
  refresh(svc: ResolvedService): Promise<ResolvedService>
  /** @experimental Not covered by the 1.0 stability promise (TAPI-22 payments / ServiceDirectory are not deployed); may change in a 1.x minor release. Consent to the service's current prices (all methods, or one). Returns the accepted price map (base units). */
  acceptPrice(svc: ResolvedService, method?: string): Record<string, bigint>
  /** @experimental Not covered by the 1.0 stability promise (TAPI-22 payments / ServiceDirectory are not deployed); may change in a 1.x minor release. */
  acceptedPrice(svc: ResolvedService, method: string): bigint | undefined
  /** Call one method; the answer's signature is verified against the delegated signer. */
  call<T = any>(svc: ResolvedService, method: string, params?: Record<string, unknown>, opts?: CallOptions): Promise<CallResult<T>>
  /** Call several independent providers and require `quorum` identical verified answers (TAPI-23). */
  callQuorum<T = any>(services: ResolvedService[], method: string, params?: Record<string, unknown>, opts?: QuorumOptions): Promise<QuorumResult<T>>
  /** @experimental Not covered by the 1.0 stability promise (TAPI-22 payments / ServiceDirectory are not deployed); may change in a 1.x minor release. A voucher signer for paid calls (TAPI-22). */
  payer(opts: PayerOptions): Payer
  tx: TxBuilders
  /** The quorum RPC client, or null when no rpcUrls were given. */
  rpc: Rpc | null
  chain: ChainReads
  chainId: number
  groupVerifier(): (member: Record<string, unknown>, opts?: { fresh?: boolean }) => Promise<boolean>
  addresses: { hub: Address; siteRegistry: Address; factory: Address; /** @experimental */ directory: Address | undefined; /** @experimental */ escrow: Address | undefined }
  randomPrivateKey(): Hex
  /** The client for another TapeOut chain (this client for its own chain). */
  forChain(chainId: number): TapeAPI
  /** Which supported chain a container address lives on, or null. */
  chainOfContainer(container: Address): Promise<number | null>
  /** @experimental (security 1.1) Forget the delegation floor of one container, holder and signer (`chainId` defaults to
   *  this client's). Takes the `data` of a floor DELEGATION_INVALID error as it is. Resolves to true when there was one. */
  clearDelegationFloor(who: { chainId?: number; container: Address; holder: Address; signer: Address }): Promise<boolean>
  /** @experimental (1.4) The TAP-10 site status of a target in any mode: identity and site status (TAP-10 §4, §6.2) at one
   *  TAP-10 pinned block, without reading the manifest. A site status ('unpaid', 'store-changed', 'no-such-cpu', ...) is
   *  returned, never thrown; input errors, wrong-chain, stale-block and unavailable reads throw (with data.status), and so
   *  does INVALID_ARGUMENT with data.status 'unsupported' (without `allChains`: a container address that is no container
   *  of this chain, or any processor contract#ID string) or 'ambiguous' (with `allChains`: more than one chain resolves it;
   *  `data.candidates`). With `allChains` the result carries `chains`. */
  siteStatus(target: ResolveTarget): Promise<SiteStatus>
}

export declare function createTapeAPI(opts?: CreateTapeAPIOptions): TapeAPI
