// @tapeapi/sdk/review: evidence-backed reviews between containers. The WHOLE subpath is Experimental and outside the 1.x
// compatibility promise: the format is the draft "Evidence-Backed Reviews between Containers" (TapeOutProtocol/TAPs pull
// request #54, tap TBD) and changes with it.
import type { Address, Hex } from './common.js'
import type { TapeAPI } from './index.js'
import type { TapeAPIError } from './errors.js'
import type { AgentKit } from './agent.js'

/** @experimental The eight fields of a review (draft §2.1). bytes32 values are 0x and 64 lower-case hex digits. */
export interface Review {
  reviewer: Hex
  reviewee: Hex
  kind: 1 | 2
  score: number
  subject: Hex
  evidenceHash: Hex
  textHash: Hex
  issued: number
}
/** @experimental The text object (§3). */
export interface ReviewText { body: string; tags?: string[]; [k: string]: unknown }
/** @experimental A record (§2.2): the review, its signature, optionally the text and the evidence. */
export interface ReviewRecord { review: Review; sig: Hex; text?: ReviewText; evidence?: Record<string, unknown>; [k: string]: unknown }
/** @experimental A container on a chain. */
export interface ReviewParty { chainId: number; container: Address }
/** @experimental The chain facts the draft's vectors give (checkReview). */
export interface ReviewFacts { holders: Record<string, Address>; signers?: Record<string, Address>; contracts?: Address[] }
/** @experimental The result of §6 for one record. */
export interface ReviewResult {
  valid: boolean
  /** a rejected record MUST NOT be shown or counted */
  rejected: boolean
  hash: Hex | null
  level: 0 | 1 | 2
  signedBy: 'holder' | 'delegate' | null
  counted: boolean
  problems: string[]
  details: { code: string; message: string }[]
  textWithheld: boolean
  reviewer: { chainId: number; container: Address; endpoint: Hex; holder: Address; delegate: Address | null; name?: string } | null
  reviewee: { chainId: number; container: Address; endpoint: Hex; holder: Address; signer: Address | null; name?: string } | null
}
/** @experimental A record with its result, and how it travelled. */
export interface ReviewItem {
  record: ReviewRecord
  result: ReviewResult
  carriage?: {
    kind: 'site-file' | 'tapesend'
    chainId: number
    container?: Address
    inboxIndex?: number
    blockNumber?: number
    time?: number
    ref?: Hex
    body?: string
    sendingWallet?: Address | null
    indirect?: boolean
    walletUnavailable?: string
    walletDiffersFromHolder?: boolean | null
  }
}
/** @experimental One evidence level of a summary (§9). */
export interface ReviewLevelSummary { reviewers: number; holders: number; scores: [number, number, number, number, number]; issued: [number, number] | null }
/** @experimental A summary (§9). Not proof of quality, honesty or availability. */
export interface ReviewSummary { level1: ReviewLevelSummary; level2: ReviewLevelSummary; uncountedPairs: number; conflicts: number }

/** @experimental */
export declare const REVIEW_TYPE: string
/** @experimental */
export declare const REVIEW_TYPEHASH: Uint8Array
/** @experimental */
export declare const REVIEW_KIND: 1
/** @experimental */
export declare const WITHDRAWAL_KIND: 2
/** @experimental `tape-review:` */
export declare const REVIEW_ID_PREFIX: string
/** @experimental 7,776,000 s (90 days) */
export declare const MAX_EVIDENCE_AGE_S: number
/** @experimental 300 s */
export declare const ISSUED_SKEW_S: number
/** @experimental */
export declare const MAX_TEXT_CODE_POINTS: number
/** @experimental */
export declare const MAX_TAGS: number
/** @experimental */
export declare const REVIEW_PUBLIC_NOTICE: string
/** @experimental A record's shape is wrong: INVALID_ARGUMENT with data.reason the draft's problem name. */
export declare class ReviewFormError extends TapeAPIError { constructor(reason: string, message?: string) }
/** @experimental The TAP-10 §12.1 endpoint ID of a container on a chain. */
export declare function endpointId(chainId: number, container: Address): Hex
/** @experimental */
export declare function parseEndpoint(endpoint: Hex): ReviewParty
/** @experimental Whether the chain is in the TAP-10 §2.1 chain table. */
export declare function isTapeOutChain(chainId: number): boolean
/** @experimental */
export declare function normalizeReview(review: Review): Review
/** @experimental hashStruct of a review. */
export declare function hashReview(review: Review): Uint8Array
/** @experimental The EIP-712 digest: TAP-11 domain, chainId the reviewer's chain. */
export declare function reviewDigest(review: Review, opts?: { hub?: Address }): Uint8Array
/** @experimental The review hash, the record's identity. */
export declare function reviewHashOf(review: Review, opts?: { hub?: Address }): Hex
/** @experimental Sign with the reviewer's current holder or its delegate. */
export declare function signReview(review: Review, privateKey: Hex, opts?: { hub?: Address }): Hex
/** @experimental The wallet payload with what the console should show beside it (§5). */
export declare function reviewTypedData(review: Review, opts?: { hub?: Address; revieweeName?: string; text?: ReviewText; evidence?: Record<string, unknown> }): {
  warnings: string[]
  display: Record<string, unknown>
  domain: { name: 'TapeAPI'; version: '1'; chainId: number; verifyingContract: Address }
  types: Record<string, { name: string; type: string }[]>
  primaryType: 'Review'
  message: Review
}
/** @experimental keccak256(utf8(canonicalJSON(value))) */
export declare function jsonHash(value: unknown): Hex
/** @experimental Why a text object breaks §3, or null. */
export declare function textProblem(text: unknown): string | null
/** @experimental */
export declare function textHashOf(text: ReviewText): Hex
/** @experimental */
export declare function evidenceHashOf(evidence: Record<string, unknown>): Hex
/** @experimental A TAP-13 request id that names the reviewer (a label, never the caller's identity). */
export declare function reviewRequestId(reviewerContainer: Address, nonce?: string): string
/** @experimental The subject that evidence names, computed without the chain. */
export declare function subjectOf(evidence: Record<string, unknown>, parties: { reviewer: Hex; reviewee: Hex; hub?: Address }): Hex
/** @experimental Build a review's fields from its parts (hashes computed here). */
export declare function makeReview(o: {
  reviewer: Hex | ReviewParty
  reviewee: Hex | ReviewParty
  kind?: 1 | 2
  score?: number
  text?: ReviewText
  evidence?: Record<string, unknown>
  subject?: Hex
  issued?: number
  hub?: Address
}): { review: Review; text?: ReviewText; evidence?: Record<string, unknown> }

/** @experimental `.well-known/tapeapi-reviews.json` */
export declare const REVIEWS_KEY: string
/** @experimental 262,144 bytes */
export declare const REVIEWS_LIMIT: number
/** @experimental "1" */
export declare const REVIEWS_FORMAT: string
/** @experimental Every problem name of the draft. */
export declare const REVIEW_PROBLEMS: readonly string[]
/** @experimental */
export declare const REVIEW_PROVES: string
/** @experimental */
export declare const REVIEW_DOES_NOT_PROVE: readonly string[]
/** @experimental Verify one record against given chain facts (declines EIP-1271). */
export declare function checkReview(record: unknown, facts: ReviewFacts, opts: { now: number; hub?: Address }): Promise<ReviewResult>
/** @experimental §7 then §9 over verified records. */
export declare function summarizeReviews(items: { record: ReviewRecord; result: ReviewResult }[], opts?: { reviewee?: Hex; holderOf?: (reviewer: Hex, item: { record: ReviewRecord; result: ReviewResult }) => Address }): ReviewSummary
/** @experimental A record's text as plain text for display, marked as the reviewer's statement. */
export declare function reviewTextForDisplay(record: unknown): { body: string; tags: string[]; statedBy: 'the reviewer' } | null
/** @experimental The bytes of a reviewer's site file. */
export declare function reviewFileBytes(records: ReviewRecord[]): Uint8Array
/** @experimental The content of a public TapeSend message carrying a record. */
export declare function reviewMessageContent(record: ReviewRecord, opts?: { body?: string }): Uint8Array

/** @experimental */
export interface ReviewKitOptions {
  clock?: () => number
  /** false: decline EIP-1271 (default true) */
  eip1271?: boolean
  kits?: Record<number, AgentKit>
}
/** @experimental */
export interface ReviewFileRead { status: 'none' | 'invalid' | 'ok'; reason?: string; items: ReviewItem[]; ignored: number; skipped: number }
/** @experimental */
export interface ReviewMessagesRead { count: number; items: ReviewItem[]; skipped: { inboxIndex: number; why: string }[] }
/** @experimental */
export interface ReviewKit {
  verifyReview(record: unknown, opts?: { now?: number }): Promise<ReviewResult>
  verifyReviews(records: unknown[], opts?: { now?: number }): Promise<{ record: ReviewRecord; result: ReviewResult }[]>
  readReviewFile(reviewer: Address | Hex | ReviewParty, opts?: { reviewee?: Address | Hex | ReviewParty; now?: number }): Promise<ReviewFileRead>
  readReviewMessages(reviewee: Address | Hex | ReviewParty, opts?: { chainId?: number; start?: number; limit?: number; from?: Address }): Promise<ReviewMessagesRead>
  chainId: number
}
/** @experimental Review checks bound to one client (strict reads, one pinned block per chain and verification). */
export declare function createReviewKit(api: TapeAPI, opts?: ReviewKitOptions): ReviewKit
