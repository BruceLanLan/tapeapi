// Security 1.1 helpers. Everything here is @experimental: outside the 1.0 stability promise; may change in a 1.x minor release.
import type { Address, Hex, BigNumberish } from './common.js'
import type { TapeAPI, ResolvedService, CallOptions, CallResult } from './index.js'

/** @experimental The ERC-6551 account (container) address derived locally: CREATE2 by `registry`, salt 0 by default. */
export declare function erc6551Account(p: { registry: Address; implementation: Address; chainId: BigNumberish; tokenContract: Address; tokenId: BigNumberish; salt?: BigNumberish | Hex }): Address

/** The block a signed result names inside itself: TAP-23 { chainId, blockNumber, blockHash }, or a blockPinned { blockNumber, blockHash }. */
export interface SignedBlock { chainId?: number; blockNumber: number; blockHash: Hex }
/** @experimental */
export declare function signedBlockOf(result: unknown): SignedBlock | null
/** @experimental keccak256(canonicalJSON(what the result states about its block)), 0x hex. For a blockPinned result the
 *  statement is the whole signed result without `blockPinned`: only for methods whose result the block fully determines
 *  (a varying field such as `fetchedAt` makes two honest answers differ). */
export declare function statementHash(result: unknown): Hex

/** One verified TAP-21 ok envelope, as a ContradictionRecord carries it. */
export interface RecordEnvelope { container: Address; signer: Address; id: string; ts: number; ok: true; result: unknown; sig: Hex; resultHash?: Hex }
/** @experimental ContradictionRecord v1 (TAP-23 §8, informative). */
export interface ContradictionRecord {
  tapeapiContradiction: 1
  request: { method: string; params: unknown }
  requestHash: Hex
  block: SignedBlock
  envelopes: [RecordEnvelope, RecordEnvelope]
}
/** @experimental Throws INVALID_ARGUMENT when the two envelopes are not a contradiction. */
export declare function contradictionRecord(p: { method: string; params?: unknown; a: Omit<RecordEnvelope, 'ok' | 'resultHash'> & { ok?: true }; b: Omit<RecordEnvelope, 'ok' | 'resultHash'> & { ok?: true } }): ContradictionRecord
export type ContradictionCheck =
  /** Signatures consistent AND every signer confirmed by `signerOf` as the one its container delegates to. */
  | { valid: true; kind: 'self' | 'cross'; weak: boolean; block: SignedBlock; signaturesConsistent: true; signersChecked: true }
  /** The signatures are consistent, but no `signerOf` was given (or it threw): the record binds no provider yet. */
  | { valid: false; reason: string; signaturesConsistent: true; signersChecked: false; kind: 'self' | 'cross'; weak: boolean; block: SignedBlock }
  | { valid: false; reason: string; signaturesConsistent?: undefined }
/** @experimental Checks a record. `valid: true` only when `signerOf(container)` confirms every signer: the record alone
 *  cannot show that a signer is the one its container delegates to (anyone can sign envelopes naming any container).
 *  Without `signerOf`, a consistent record is `valid: false` with `signaturesConsistent: true`. A blockPinned record is
 *  only meaningful for a method whose result the block fully determines. */
export declare function verifyContradiction(record: unknown, opts?: { signerOf?: (container: Address) => Promise<Address> | Address }): Promise<ContradictionCheck>
/** @experimental Every record the envelopes of a callQuorum disagreement (error.data.envelopes) support. */
export declare function contradictionsOf(error: unknown): ContradictionRecord[]

/** @experimental The outcome of one second opinion. */
export interface SpotCheckOutcome {
  same: boolean
  checked: Address
  primary: Omit<RecordEnvelope, 'ok' | 'resultHash'>
  other: Omit<RecordEnvelope, 'ok' | 'resultHash'>
  /** Present when the two answers differ and name the same signed block. */
  record?: ContradictionRecord
}
export interface SpotCheckOptions {
  /** Probability of a second opinion per call, 0..1 (default 0: off). */
  rate?: number
  /** Resolved services to pick the second opinion from; only those independent of the one called (TAP-23 §3.5) are used. */
  alternates?: ResolvedService[]
  /** Uniform [0, 1) (default: crypto.getRandomValues). */
  random?: () => number
  /** May be async; a throw or a rejection is ignored. */
  onMismatch?: (outcome: SpotCheckOutcome) => unknown
  /** May be async; a throw or a rejection is ignored. */
  onError?: (error: unknown) => unknown
  /** Wait for the check and add `spotCheck` to the answer (default false: the check runs in the background). */
  wait?: boolean
  /** Also ask an alternate that charges for the method, with the call's payer (default false). */
  allowPaid?: boolean
}
/** @experimental A wrapper whose call() asks one more independent provider with probability `rate` and compares bytes. */
export declare function withSpotCheck(api: Pick<TapeAPI, 'call'>, opts?: SpotCheckOptions): {
  call<T = any>(svc: ResolvedService, method: string, params?: Record<string, unknown>, opts?: CallOptions): Promise<CallResult<T> & { spotCheck?: SpotCheckOutcome | { error: unknown } }>
}
