// @tapeapi/sdk/agent: container agents, phase 0. The WHOLE subpath is Experimental (1.7) and outside the 1.x
// compatibility promise: the formats follow the public Ideas TapeOutProtocol/TAPs#40 and #41 and may change with them.
// Phase 0 has no enforcement: every check returns `enforcement: 'none'`.
import type { Address, Hex, BigNumberish, TxRequest } from './common.js'
import type { TapeAPI } from './index.js'
import type { AgentMember } from './manifest.js'

/** @experimental */
export declare const AGENT_FORMAT_VERSION: 0
/** @experimental the agent is paid for the task */
export declare const MODE_PAY: 0
/** @experimental the agent spends the principal's budget on third parties */
export declare const MODE_SPEND: 1
/** @experimental */
export declare const VERDICT_ACCEPT: 1
/** @experimental */
export declare const VERDICT_REJECT: 2
/** @experimental */
export declare const MAX_SCOPE_ITEMS: number
/** @experimental */
export declare const MAX_REVOKED_HASHES: number
/** @experimental */
export declare const SCOPE_TYPE: string
/** @experimental encodeType of Mandate (the Scope type appended) */
export declare const MANDATE_TYPE: string
/** @experimental */
export declare const TASK_OFFER_TYPE: string
/** @experimental */
export declare const TASK_VERDICT_TYPE: string
/** @experimental */
export declare const MANDATE_REVOCATION_TYPE: string
/** @experimental */
export declare const SCOPE_TYPEHASH: Uint8Array
/** @experimental */
export declare const MANDATE_TYPEHASH: Uint8Array
/** @experimental */
export declare const TASK_OFFER_TYPEHASH: Uint8Array
/** @experimental */
export declare const TASK_VERDICT_TYPEHASH: Uint8Array
/** @experimental */
export declare const MANDATE_REVOCATION_TYPEHASH: Uint8Array

/** @experimental One provider the mandate names, with a token and a cap (phase 0: the cap "0", the token the zero address). */
export interface MandateScope { provider: Address; token: Address; cap: BigNumberish }
/** @experimental The mandate a principal container's holder signs (EIP-712, TAP-11 delegation domain). */
export interface Mandate {
  principal: Address
  agent: Address
  agentKey: Address
  mode: 0 | 1
  taskHash: Hex
  scope: MandateScope[]
  feeToken: Address
  feeCap: BigNumberish
  notBefore: number
  expires: number
  nonce: BigNumberish
  subdelegate: boolean
}
/** @experimental A normalised mandate: checksummed addresses, uint256 values as decimal strings. */
export interface NormalizedMandate extends Mandate { scope: Array<{ provider: Address; token: Address; cap: string }>; feeCap: string; nonce: string }
/** @experimental */
export interface TaskOffer { principal: Address; agent: Address; taskHash: Hex; mode: 0 | 1; feeToken: Address; fee: BigNumberish; deadline: number; exp: number; nonce: BigNumberish }
/** @experimental verdict 1 accepts the delivery, 2 rejects it */
export interface TaskVerdict { mandateHash: Hex; deliverableHash: Hex; verdict: 1 | 2; reasonHash?: Hex; issued: number }
/** @experimental Revokes the listed mandates and every mandate of `principal` with notBefore below `revokedBefore`. */
export interface MandateRevocation { principal: Address; mandateHashes: Hex[]; revokedBefore: number; issued: number }
/** @experimental A typed-data result. `warnings` and `display` are for the console and are neither hashed nor signed:
 *  pass the result through forWallet (or remove both yourself) before eth_signTypedData_v4. */
export interface AgentTypedData { domain: { name: string; version: string; chainId: number; verifyingContract: Address }; types: Record<string, Array<{ name: string; type: string }>>; primaryType: string; message: Record<string, unknown>; warnings?: string[]; display?: { task?: Record<string, unknown>; notBefore?: string | null; expires?: string | null; amounts?: Array<DisplayAmount & { provider: Address }>; fee?: DisplayAmount & { agent: Address } } }
/** @experimental What goes to the wallet (the four keys only) and what the console shows. */
export interface WalletRequest { payload: { domain: AgentTypedData['domain']; types: AgentTypedData['types']; primaryType: string; message: Record<string, unknown> }; warnings: string[]; display?: AgentTypedData['display'] }
/** @experimental Split a typed-data result of this subpath into the wallet payload and the console's warnings and display.
 *  The input must be exactly what this module builds; warnings and display are recomputed, never passed through.
 *  `expect` ({ chainId, hub }) is required: the chain and hub the holder's console expects (a domain rebuilt from itself
 *  cannot reveal a changed chainId). The holder's defence is still the fields the wallet shows. */
export declare function forWallet(td: AgentTypedData, expect: { chainId: number; hub: Address } & EscrowChannelPayloadOptions): WalletRequest
/** @experimental shown with every phase-0 mandate */
export declare const MANDATE_PHASE0_NOTICE: string
/** @experimental shown with a mandate built with allowFunds that names an amount, an asset or sub-delegation */
export declare const MANDATE_FUNDED_WARNING: string
/** @experimental `allowFunds: true` lets the SDK's own payload and signing build a mandate that names an amount, an asset
 *  or sub-delegation (never in phase 0). This guards against misuse, not against a malicious console: the digest stays
 *  computable and a console can sign it without this SDK, so the holder's defence is what the wallet shows. */
export interface FundsGate { allowFunds?: boolean }
/** @experimental The phase-0 rules: every cap and feeCap 0, every token and feeToken the zero address, subdelegate false. */
export declare function phase0Problems(m: NormalizedMandate): AgentProblem[]
/** @experimental (phase 1) The switch value: a mandate that names funds is checked against its escrow channels. */
export declare const ENFORCEMENT_ESCROW_CHANNEL: 'escrow-channel'
/** @experimental (phase 1) Any scope cap or feeCap non-zero, or any token or feeToken not the zero address. */
export declare function mandateNamesFunds(m: NormalizedMandate): boolean
/** @experimental (phase 1) The static rules of the internal draft §5.2, in this order: scope-token-cap-mismatch,
 *  fee-token-cap-mismatch, scope-duplicate-provider, mode-scope-mismatch, subdelegate-not-allowed. */
export declare function phase1Problems(m: NormalizedMandate): AgentProblem[]
/** @experimental (phase 1) The static half of scope-includes-agent: a capped provider that is the agent's own container. Warnings, never refused. */
export declare function phase1Warnings(m: NormalizedMandate): AgentProblem[]
/** @experimental (phase 1) shown instead of MANDATE_FUNDED_WARNING when the payload is built with { enforcement: 'escrow-channel' } */
export declare const MANDATE_ESCROW_CHANNEL_WARNING: string
/** @experimental (phase 1) Build the wallet payload under the phase-1 rules (a mandate that breaks them is refused) and
 *  show every amount; `decimals` are the tokens' decimals() the console read on chain. */
export interface EscrowChannelPayloadOptions { enforcement?: 'escrow-channel'; decimals?: Record<string, number> }
/** @experimental (phase 1) One amount the console shows: always in the smallest unit; in whole tokens when decimals are given. */
export interface DisplayAmount { token: Address; amount: string; decimals: number | null; display: string }
/** @experimental shown with an offer whose fee is not 0 */
export declare const OFFER_FEE_WARNING: string

/** @experimental keccak256(UTF-8(canonicalJSON(task))) */
export declare function taskHashOf(task: Record<string, unknown>): Hex
/** @experimental keccak256(UTF-8(canonicalJSON(value))) */
export declare function jsonHashOf(value: unknown): Hex
/** @experimental `wire` (1.8): only the JSON forms of draft TAP §3.7, as a message received from a counterparty must have
 *  (a uint256 as a decimal string, never a number or a bigint); the default also takes a number or a bigint. A bytes32
 *  is lower case in both. */
export interface WireOption { wire?: boolean }
/** @experimental */
export declare function normalizeMandate(m: Mandate, opts?: WireOption): NormalizedMandate
/** @experimental */
export declare function hashScope(s: MandateScope): Uint8Array
/** @experimental */
export declare function hashMandate(m: Mandate): Uint8Array
/** @experimental the digest the holder signs; also the mandate's identity */
export declare function mandateDigest(chainId: number, hub: Address, m: Mandate): Uint8Array
/** @experimental mandateDigest as 0x hex: the thread key */
export declare function mandateHashOf(chainId: number, hub: Address, m: Mandate): Hex
/** @experimental */
export declare function mandateTypedData(chainId: number, hub: Address, m: Mandate, opts?: FundsGate & EscrowChannelPayloadOptions & { task?: Record<string, unknown> }): AgentTypedData
/** @experimental signs with a local key (tests, scripts); a wallet signs mandateTypedData instead */
export declare function signMandate(chainId: number, hub: Address, m: Mandate, privateKey: Hex | Uint8Array, opts?: FundsGate & { enforcement?: 'escrow-channel' }): Hex
/** @experimental */
export declare function normalizeTaskOffer(o: TaskOffer, opts?: WireOption): TaskOffer & { fee: string; nonce: string }
/** @experimental */
export declare function hashTaskOffer(o: TaskOffer): Uint8Array
/** @experimental */
export declare function taskOfferDigest(chainId: number, hub: Address, o: TaskOffer): Uint8Array
/** @experimental */
export declare function offerHashOf(chainId: number, hub: Address, o: TaskOffer): Hex
/** @experimental */
export declare function taskOfferTypedData(chainId: number, hub: Address, o: TaskOffer): AgentTypedData
/** @experimental */
export declare function signTaskOffer(chainId: number, hub: Address, o: TaskOffer, privateKey: Hex | Uint8Array): Hex
/** @experimental A missing reasonHash reads as 32 zero bytes, except with `wire` (1.8), where it is refused. */
export declare function normalizeTaskVerdict(v: TaskVerdict, opts?: WireOption): Required<TaskVerdict>
/** @experimental */
export declare function hashTaskVerdict(v: TaskVerdict): Uint8Array
/** @experimental */
export declare function taskVerdictDigest(chainId: number, hub: Address, v: TaskVerdict): Uint8Array
/** @experimental */
export declare function verdictHashOf(chainId: number, hub: Address, v: TaskVerdict): Hex
/** @experimental */
export declare function taskVerdictTypedData(chainId: number, hub: Address, v: TaskVerdict): AgentTypedData
/** @experimental */
export declare function signTaskVerdict(chainId: number, hub: Address, v: TaskVerdict, privateKey: Hex | Uint8Array): Hex
/** @experimental */
export declare function normalizeMandateRevocation(r: MandateRevocation, opts?: WireOption): MandateRevocation
/** @experimental */
export declare function hashMandateRevocation(r: MandateRevocation): Uint8Array
/** @experimental */
export declare function mandateRevocationDigest(chainId: number, hub: Address, r: MandateRevocation): Uint8Array
/** @experimental */
export declare function mandateRevocationTypedData(chainId: number, hub: Address, r: MandateRevocation): AgentTypedData
/** @experimental */
export declare function signMandateRevocation(chainId: number, hub: Address, r: MandateRevocation, privateKey: Hex | Uint8Array): Hex

/** @experimental TAP-10 §16 rendering for text a counterparty wrote: invisible and control characters removed, cut. */
export declare function plainText(s: unknown, max?: number): string
/** @experimental (1.8) Draft TAP §7.2 steps 1-3 for an agent message's receipt, without the chain: the first problem
 *  (message-malformed or agent-mismatch) or null. */
export declare function agentMessageProblem(receipt: unknown, kind: 'accept' | 'deliver', agent: Address): AgentProblem | null
/** @experimental (1.8) The form of a hash-only (v 2) evidence receipt (draft TAP §8): receipt-not-hash-only or null. */
export declare function hashOnlyReceiptProblem(receipt: unknown): AgentProblem | null
/** @experimental The compact bytes of the principal's revocation list (size checked against MANDATES_LIMIT). */
export declare function revocationFileBytes(o: { chainId: number; revocation: MandateRevocation; sig: Hex }): Uint8Array
/** @experimental site file of the principal's revocation list */
export declare const MANDATES_KEY: string
/** @experimental */
export declare const MANDATES_LIMIT: number
/** @experimental */
export declare const MANDATES_FORMAT: string
/** @experimental expires − notBefore of a mandate, at most */
export declare const MAX_MANDATE_S: number
/** @experimental */
export declare const REVOCATION_ISSUED_SKEW_S: number
/** @experimental the six implemented message kinds */
export declare const THREAD_KINDS: readonly ['offer', 'accept', 'mandate', 'deliver', 'acceptance', 'revocation']
/** @experimental named in Idea #41, not implemented: a thread carrying one is refused */
export declare const RESERVED_KINDS: readonly ['quote', 'progress', 'reject', 'cancel', 'dispute']
/** @experimental */
export declare const KIND_PREFIX: 'tape.agent/'
/** @experimental */
export type TaskState = 'Offered' | 'Accepted' | 'Active' | 'Delivered' | 'Settled' | 'Expired' | 'Rejected' | 'Cancelled'
/** @experimental */
export declare const TASK_STATES: readonly TaskState[]
/** @experimental */
export declare const EVIDENCE_PROVES: string
/** @experimental */
export declare const EVIDENCE_DOES_NOT_PROVE: readonly string[]

/** @experimental */
export interface AgentProblem { code: string; message: string }
/** @experimental A container read from the chain as TAP-10 §4.3 says, at the verification's pinned block: its processor
 *  number and on-chain name (since 1.8 always found on the chain; null only in 1.7), never a manifest's `name`. */
export interface ContainerIdentity { container: Address; chainId: number; circuits: Address; tokenId: string; processor?: number; holder: Address; name: string | null }
/** @experimental */
export interface RevocationList { status: 'published' | 'none-published' | 'invalid'; issued?: number; revokedBefore?: number; mandateHashes?: Hex[]; reason?: string }
/** @experimental (phase 1) The escrow's WITHDRAW_COOLDOWN, 48 hours in seconds. */
export declare const WITHDRAW_COOLDOWN_S: number
/** @experimental (phase 1) The escrow's WITHDRAW_WINDOW, 7 days in seconds. */
export declare const WITHDRAW_WINDOW_S: number
/** @experimental (phase 1) requestedAt ≠ 0 and now ≤ requestedAt + WITHDRAW_COOLDOWN_S + WITHDRAW_WINDOW_S: the escrow
 *  never clears a lapsed request, so its pendingWithdraw view alone cannot say whether a request is live (R21). */
export declare function withdrawRequestLive(requestedAt: number | bigint, now: number): boolean
/** @experimental (phase 1) A withdraw request on a channel and whether it is live: requestedAt ≠ 0 and
 *  at ≤ requestedAt + 48 h + 7 d (the escrow's view keeps a lapsed request). */
export interface PendingWithdrawReading { amount: string; requestedAt: number; live: boolean }
/** @experimental (phase 1) What one capped scope item reads on chain, at the verification's pinned block. */
export interface ChannelReading {
  provider: Address
  escrow: Address | null
  token: Address
  decimals: number | null
  cap: string
  channel: string | null
  /** channel minus the amount of a live withdraw request (TAPI-22 §3.2(4)), never below 0 */
  available: string | null
  pendingWithdraw: PendingWithdrawReading | null
  sessionExpiry: number | null
  /** claimedOf at this check: what was already settled on the channel (draft §2.3 rule 5) */
  claimedAtCheck: string | null
}
/** @experimental (phase 1) The fee channel (consumer, agent) when feeCap > 0. */
export interface FeeChannelReading { agent: Address; escrow: Address | null; token: Address; decimals: number | null; cap: string; channel: string | null; available: string | null; pendingWithdraw: PendingWithdrawReading | null; agentKeySession: number | null }
/** @experimental (phase 1) Options of the escrow-channel check. */
export interface EscrowChannelOptions {
  /** 'escrow-channel': check a mandate that names funds by the phase-1 rules; anything else, or none: phase 0 */
  enforcement?: 'escrow-channel'
  /** who funded the channels: 'holder' (default; the principal's current holder, F2) or 'container' (the principal, F1) */
  fundingPath?: 'holder' | 'container'
  /** the prepayment or milestone amount agreed for the fee channel (decimal string); fee-channel-short below it */
  feeDue?: string
}
/** @experimental */
export interface MandateCheck {
  ok: boolean
  problems: AgentProblem[]
  enforcement: 'none'
  phase: 0
  mandateHash?: Hex
  mandate?: NormalizedMandate
  principal?: ContainerIdentity
  agent?: Address
  agentKey?: Address
  notBefore?: number
  expires?: number
  revocation?: { status: string; revoked: boolean; at?: number; via?: 'site' | 'message'; site?: RevocationList }
}
/** @experimental (phase 1) The check of a mandate that names funds, made with { enforcement: 'escrow-channel' }. */
export interface EscrowChannelMandateCheck extends Omit<MandateCheck, 'enforcement' | 'phase'> {
  /** 'escrow-channel' only when every phase-1 check passed (ok true); 'none' otherwise */
  enforcement: 'none' | 'escrow-channel'
  phase: 1
  /** what the chain bounds: each channel's balance (channelOf), never the mandate's cap; a channel above its cap is the
   *  problem channel-exceeds-cap (review p1m12 F2) */
  bound: 'channel'
  /** reported, never refused (scope-includes-agent) */
  warnings: AgentProblem[]
  consumer?: Address
  fundingPath?: 'holder' | 'container'
  scope?: ChannelReading[]
  fee?: FeeChannelReading
}
/** @experimental */
export interface EvidenceCheck {
  ok: boolean
  enforcement: 'none'
  problems: AgentProblem[]
  proves: string
  doesNotProve: string[]
  receipts: Array<{ container: Address; name: string | null; method: string; ts: number; ok: boolean; answeredBy: boolean }>
  /** @experimental (phase 1, M7) the delivery's spend statement reconciled (spendEvidence): present only with the
   *  escrow-channel switch and a mandate that names funds: for a deliver result with a `spend` member as reconciled, and
   *  without the member as `{ items: [], warnings: [spend-evidence-absent] }`; its problems are in `problems`, its
   *  mismatches (always warnings) here */
  spend?: { items: SpendEvidenceItem[]; warnings: AgentProblem[] }
}
/** @experimental A signed holder message or an agent receipt in a thread. */
export type ThreadMessage =
  | { v: 0; kind: 'tape.agent/offer'; task: Record<string, unknown>; offer: TaskOffer; sig: Hex }
  | { v: 0; kind: 'tape.agent/accept'; receipt: Record<string, any> }
  | { v: 0; kind: 'tape.agent/mandate'; mandate: Mandate; sig: Hex }
  | { v: 0; kind: 'tape.agent/deliver'; receipt: Record<string, any> }
  | { v: 0; kind: 'tape.agent/acceptance'; verdict: TaskVerdict; sig: Hex }
  | { v: 0; kind: 'tape.agent/revocation'; revocation: MandateRevocation; sig: Hex }
/** @experimental */
export interface ThreadCheck {
  ok: boolean
  state: TaskState | null
  problems: AgentProblem[]
  enforcement: 'none'
  /** always present: true when principal and agent are one party (same container, same holder, signer or key) */
  selfHire: boolean
  selfHireReasons: Array<'same-container' | 'same-holder' | 'agent-signer-is-principal-holder' | 'agent-key-is-principal-holder'>
  principal?: ContainerIdentity
  agent?: Partial<ContainerIdentity> & { container: Address; signer?: Address; displayName?: { text: string; untrusted: true } }
  offerHash?: Hex
  taskHash?: Hex
  mandateHash?: Hex
  mandate?: NormalizedMandate
  mandateCheck?: MandateCheck
  deliveries: Array<{ deliverableHash: Hex; ts: number; exp: number; receiptsHash: Hex; evidence: EvidenceCheck }>
  evidence?: EvidenceCheck
  verdict: { verdict: 'accepted' | 'rejected'; issued: number; reasonHash: Hex; deliverableHash: Hex; verdictHash: Hex } | null
  /** The revocation time R (draft TAP §7.5): the smallest `issued` of the revocations that apply, and where it came from.
   *  It only refuses agent messages signed after it (message-after-revocation); it does not mean the thread was
   *  cancelled: `state` is Cancelled only when the thread was still Offered, Accepted or Active and R <= at. */
  revoked: { at: number; via: 'site' | 'message' } | null
  /** Delivered and no verdict before the delivery's own exp (there is no arbiter) */
  unaccepted: boolean
}
/** @experimental (phase 1) A thread checked with { enforcement: 'escrow-channel' } whose applied mandate names funds:
 *  enforcement and the readings come from that mandate's check, at the same pinned block. */
export interface EscrowChannelThreadCheck extends Omit<ThreadCheck, 'enforcement' | 'mandateCheck'> {
  /** 'escrow-channel' only when the whole thread is ok and its applied mandate's check said so; 'none' otherwise
   *  (mandateCheck.enforcement keeps the mandate's own value) */
  enforcement: 'none' | 'escrow-channel'
  phase: 1
  bound: 'channel'
  warnings: AgentProblem[]
  mandateCheck?: EscrowChannelMandateCheck
  consumer?: Address
  fundingPath?: 'holder' | 'container'
  scope?: ChannelReading[]
  fee?: FeeChannelReading
}
/** @experimental The options of verifyMandate (phase 0, as in 1.8). */
export interface MandateCheckOptions { agentKey?: Address; agent?: Address; at?: number; readSite?: boolean; revocations?: Array<{ revocation: MandateRevocation; sig: Hex }> }
/** @experimental */
export interface AgentKitOptions {
  clock?: () => number
  revocationFloor?: { get(key: string): unknown; set(key: string, value: number): unknown }
  /** a Map, or a store whose setIfAbsent stores the value only when the key is absent and returns the previous value, in one step */
  nonces?: Map<string, string> | { setIfAbsent(key: string, value: string): string | undefined | Promise<string | undefined> }
  /** resolves the agent and the providers. Default (1.9): as TAP-11 §2 says, by the conformance mode (conform: 'tap10')
   *  made from the kit's client (its nodes and options, never allChains; the client itself when it is in that mode), or
   *  the client's own resolve when its contracts are not the ones TAP-10 lists for its chain (AgentKit.resolution) */
  resolve?: (container: Address) => Promise<any>
  /** @experimental (phase 1) escrows, besides AUDITED_ESCROWS (empty), the escrow-channel check accepts */
  allowEscrows?: Address[]
}
/** @experimental */
export interface AgentKit {
  /** agentKey / agent: when given, the mandate must name exactly these, and a mismatch keeps the nonce unrecorded; without
   *  them nothing is compared and the nonce is recorded when the other checks allow it */
  verifyMandate(signed: { mandate: Mandate; sig: Hex }, opts: MandateCheckOptions & EscrowChannelOptions & { enforcement: 'escrow-channel' }): Promise<MandateCheck | EscrowChannelMandateCheck>
  verifyMandate(signed: { mandate: Mandate; sig: Hex }, opts?: MandateCheckOptions): Promise<MandateCheck>
  /** @experimental (phase 1) with the switch, a thread whose applied mandate names funds gives an EscrowChannelThreadCheck */
  verifyTaskThread(messages: ThreadMessage[], opts: { at?: number; readSite?: boolean } & EscrowChannelOptions & { enforcement: 'escrow-channel' }): Promise<ThreadCheck | EscrowChannelThreadCheck>
  verifyTaskThread(messages: ThreadMessage[], opts?: { at?: number; readSite?: boolean }): Promise<ThreadCheck>
  /** @experimental (phase 1, M7) with enforcement 'escrow-channel' and a mandate that names funds, a `spend` member of
   *  the deliver result is reconciled against `scope` (a phase-1 check's readings, optional) and the receipts that verified */
  verifyEvidence(deliver: { receipts: unknown[]; receiptsHash: Hex; spend?: unknown }, opts: { mandate: Mandate; enforcement?: 'escrow-channel'; scope?: Array<Pick<ChannelReading, 'provider' | 'escrow' | 'claimedAtCheck'>> }): Promise<EvidenceCheck>
  readRevocations(principal: Address): Promise<RevocationList>
  identityOf(container: Address): Promise<ContainerIdentity>
  /** @experimental (phase 1, M3) escrowPlan from facts read at one pinned block (on the container path, the TapeOut fee
   *  found by simulating execute); `holder` is the wallet that sends it. `history` is REQUIRED (review p1m3 recheck 3):
   *  the console's session history with every plan's record, or [] when the console confirms it has none; left out is
   *  INVALID_ARGUMENT. The premise (draft §10.5): for each (mandate, provider), what the agent key spent on every channel
   *  the history records plus what is still open to it stays within the cap; a channel the history does not record (a
   *  lost history after the provider changed its escrow) is not seen, and a whole cap may be funded there again */
  holderPlan(mandate: Mandate, opts: { holder: Address; path?: FundingPath; /** REQUIRED: the session history, [] when there is none */ history: SessionEntry[]; /** review p1m3 recheck 3: the signed mandate, or (not both) the address that signed it: a holder that is not its signer is holder-changed-since-signing */ signed?: { mandate: Mandate; sig: Hex }; signer?: Address; now?: number; /** REQUIRED on the container path: the most each execute may take as the TapeOut fee (execute-fee-too-high) */ maxExecuteFee?: BigNumberish }): Promise<EscrowPlan & { pin: { number: number; hash: Hex }; facts: EscrowPlanFacts & { executeFee?: string | null; providers: EscrowPlanProvider[] } }>
  /** @experimental (phase 1, M3) closeOutPlan from the channels read at one pinned block; `escrows` names where the money is */
  closeOut(mandate: Mandate, opts: { holder: Address; path?: FundingPath; now?: number; escrows?: Record<string, Address>; /** REQUIRED on the container path */ maxExecuteFee?: BigNumberish; /** REQUIRED (review p1m3 recheck 3): the plan's record or the session history, [] when there is none (consumer-unknown) */ history: SessionEntry[]; /** replace a live partial request by one for the whole channel */ fullRequest?: boolean }): Promise<CloseOutPlan & { pin: { number: number; hash: Hex } }>
  /** @experimental (phase 1, M3) planApplied from readings at a new pinned block, after the plan was sent */
  afterPlan(plan: EscrowPlan, mandate: Mandate): Promise<PlanApplied & { readings: { allowances: Array<{ escrow: Address; allowance: string }>; channels: Array<{ provider: Address; channel: string; session: number; claimed: string }> }; pin: { number: number; hash: Hex } }>
  /** @experimental (phase 1, S4b) SessionAuthorized logs of `consumer` on `escrow`, as session entries without a mandate hash */
  sessionLogs(opts: { escrow: Address; consumer: Address; fromBlock: number; toBlock: number }): Promise<Array<SessionEntry & { block: number }>>
  chainId: number
  hub: Address
  /** how the agent and the providers are resolved (1.9): 'tap10' the conformance mode made from the client (TAP-11 §2),
   *  'client' the client's own resolve (its contracts are not the ones TAP-10 lists for its chain: a local or test
   *  deployment), 'caller' the `resolve` option */
  resolution: 'tap10' | 'client' | 'caller'
}
/** @experimental Container-agent checks bound to one client (rpcUrls required; decisions read under strict agreement).
 *  Since 1.8 every read of one verification is made at one TAP-10 pinned block (stale-block and wrong-chain are thrown,
 *  with data.status); identity problems are not-tapeout and no-such-token (TAP-10 §4.4). */
export declare function createAgentKit(api: TapeAPI, opts?: AgentKitOptions): AgentKit

/** @experimental A TAP-10 §16.1 asset attachment. */
export type AssetAttachment =
  | { type: 'native'; chainId: number; amount: string; tx: Hex }
  | { type: 'erc20'; chainId: number; token: Address; amount: string; tx: Hex }
  | { type: 'erc721'; chainId: number; token: Address; tokenId: string; tx: Hex }
/** @experimental */
export type AttachmentResult = 'pending' | 'mismatch' | 'unavailable' | 'unverifiable' | 'late' | 'indirect' | 'third-party' | 'stale' | 'crowded' | 'not-first' | 'ok' | 'other-chain' | 'repeat'
/** @experimental */
export declare const SENT_TOPIC: Hex
/** @experimental */
export declare const TRANSFER_TOPIC: Hex
/** @experimental */
export declare const ATTACHMENT_STALE_S: number
/** @experimental */
export declare const ATTACHMENT_CROWDED: number
/** @experimental */
export declare const MAX_ATTACHMENTS: number
/** @experimental */
export declare const INBOX_PAGE_MAX: number
/** @experimental */
export declare const PENDING_WINDOW_BLOCKS: number
/** @experimental */
export declare const ATTACHMENT_RESULTS: readonly AttachmentResult[]
/** @experimental */
export declare const TRANSFER_SELECTOR: Hex
/** @experimental ERC-6551 execute(address,uint256,bytes,uint8) */
export declare const EXECUTE_SELECTOR: Hex
/** @experimental */
export declare function checkAssetAttachment(a: unknown): AssetAttachment | null
/** @experimental The TAP-10 §16 content object as UTF-8 bytes (asset attachments only). */
export declare function encodeContent(c?: { subject?: string; body?: string; ts?: number; attachments?: AssetAttachment[] }): Uint8Array
/** @experimental */
export interface DecodedContent { status: 'ok' | 'damaged' | 'unsupported'; message?: { v: 1; kind: 'message'; subject?: string; body: string; ts?: number }; attachments: AssetAttachment[]; dropped: number; images: number; reason?: string }
/** @experimental TAP-10 §16 decoding. */
export declare function decodeContent(bytes: Uint8Array): DecodedContent
/** @experimental Every field of an unsigned transaction, in words. */
export declare function describeTx(tx: TxRequest, opts?: { decimals?: number | null | 'invalid'; recipient?: PaymentRecipient | null; native?: boolean; inner?: TxRequest | null }): string[]
/** @experimental */
export interface PaymentRecipient { container: Address; circuits: Address; tokenId: string; name: string | null; holder?: Address }
/** @experimental */
export interface InboxMessage extends Omit<DecodedContent, 'status'> {
  status: string
  recipient: Address
  to: Hex
  inboxIndex: number
  messageId: Hex
  entry: { index: number; from: Address; blockNumber: number; timestamp: number; digest: Hex }
  ref?: Hex
  txHint?: Hex
}
/** @experimental */
export interface AttachmentCheck { result: AttachmentResult; step?: number; reason?: string; token?: Address; known?: boolean; payer?: Address; wallet?: Address; [key: string]: unknown }
/** @experimental An unsigned transaction with the summary to print. */
export interface UnsignedPayment extends TxRequest { recipient?: PaymentRecipient; summary: string[] }
/** @experimental The recipient is named by the chain, never by an address. */
export type PaymentTarget = { name: string } | { circuits: Address; tokenId: BigNumberish }
/** @experimental */
export interface PaymentKit {
  readMessage(o: { recipient: Address; inboxIndex: number; secretKey?: Uint8Array }): Promise<InboxMessage>
  verifyAttachment(message: InboxMessage, attachment: AssetAttachment): Promise<AttachmentCheck>
  verifyAttachments(message: InboxMessage): Promise<Array<AttachmentCheck & { attachment: AssetAttachment }>>
  sendingWallet(o: { recipient: Address; inboxIndex: number }): Promise<{ wallet?: Address; indirect?: true; unavailable?: string; reason?: string }>
  inboxCount(recipient: Address): Promise<bigint>
  transferToContainer(o: PaymentTarget & { token: Address; amount: BigNumberish }): Promise<UnsignedPayment>
  nativeToContainer(o: PaymentTarget & { amount: BigNumberish }): Promise<UnsignedPayment>
  /** only the unedited result of transferToContainer of this kit; anything else is recipient-not-from-chain.
   *  `value` is the OUTER value (smallest unit of the native coin, 0 or more): the TapeOut fee the container's execute may
   *  require (0.0002 BNB on BNB Smart Chain at the time of writing; no getter reads it: simulate and read a revert of
   *  `0xafd49700(paid, required)`). Without it the value is 0 and the summary says a call without the fee may revert.
   *  The inner value is always 0: a non-zero `tx.value` is still refused. */
  viaContainer(o: { from: Address; tx: UnsignedPayment; value?: BigNumberish }): UnsignedPayment
  recipientOf(target: PaymentTarget): Promise<PaymentRecipient>
  chainId: number
}
/** @experimental Phase-0 payment tools: read-only §19 verification and unsigned transfers. */
export declare function createPaymentKit(api: TapeAPI, opts?: { tokenAllowed?: (token: Address) => boolean }): PaymentKit
/** @experimental The order TAP-10 §19 needs, as checks in the payer's client. */
export declare function paymentOrder(opts?: { clock?: () => number }): {
  recordTransfer(o: { recipient: Address; tx: Hex }): void
  confirmTransfer(o: { recipient: Address; tx: Hex; blockTime: number }): void
  deadline(recipient: Address): number | null
  checkMessage(o: { recipient: Address; attachments?: Array<{ tx: Hex }> }): true
  messageSent(o: { recipient: Address; attachments?: Array<{ tx: Hex }> }): void
  dropTransfer(o: { recipient: Address; tx: Hex; reason: 'reverted' | 'cancelled' }): void
  replaceTransfer(o: { recipient: Address; tx: Hex; by: Hex }): void
}

/** @experimental validates a manifest's optional `agent` member (also exported by @tapeapi/sdk/manifest) */
export declare function validateAgentMember(agent: unknown): AgentMember
/** @experimental */
export declare const AGENT_PRICING_MODES: readonly ['free', 'fixed', 'quote']
/** @experimental */
export declare const AGENT_MAX_TASKS: number
/** @experimental */
export declare const AGENT_MAX_CAPABILITIES: number

/** @experimental (phase 1) Who funds the channels: 'holder' (F2, the principal's current holder) or 'container' (F1,
 *  the principal through its execute). */
export type FundingPath = 'holder' | 'container'
/** @experimental (phase 1) The one default of escrowPlan, closeOutPlan, the kit's holderPlan / closeOut and the check's
 *  fundingPath: the draft's recommendation, pending its decision D3. */
export declare const DEFAULT_FUNDING_PATH: FundingPath
/** @experimental (phase 1) Both funding paths. */
export declare const FUNDING_PATHS: readonly ['holder', 'container']
/** @experimental (phase 1) The paths of escrowPlan: FUNDING_PATHS. */
export declare const ESCROW_PLAN_PATHS: readonly ['holder', 'container']
/** @experimental (phase 1) The escrow's MAX_SESSION, 30 days in seconds. */
export declare const MAX_SESSION_S: number
/** @experimental (phase 1) The selector of the container's execute revert when the TapeOut fee is short: (paid, required). */
export declare const EXECUTE_FEE_SELECTOR: '0xafd49700'
/** @experimental (phase 1) One provider's chain facts (the kit's holderPlan reads them at one pinned block). */
export interface EscrowPlanProvider {
  provider: Address
  /** the escrow its manifest names; null when it names none (provider-unresolvable) */
  escrow: Address | null
  /** false: the escrow has no code on this chain (escrow-other-chain) */
  escrowCode?: boolean
  /** the escrow's token(); null when it answers none (escrow-token-mismatch) */
  token: Address | null
  channel?: BigNumberish
  pendingLive?: boolean
  /** the agent key's sessionExpiry on this channel: 0, or the mandate's expires (already authorised), else key-already-authorised */
  session?: BigNumberish
  /** the channel's claimedOf (what was ever settled on it): with the history's claimedAtPlan it bounds what a plan run
   *  again after it was applied funds (channel-spent, channel-exceeds-budget) */
  claimed?: BigNumberish
  /** the other funding path's channel to this provider and the agent key's session there (other-path-funded when not all 0);
   *  the kit sums it over this escrow and every escrow the session history names for this provider */
  otherPath?: { channel: BigNumberish; session: BigNumberish }
  /** review p1m3 recheck: each other channel to this provider (another escrow or consumer) on which the session history
   *  records this mandate's agent key, read at the pinned block. One the history names without a fact here, or not
   *  released (another consumer, not empty, a live request, no claimedAtPlan), is funded-elsewhere */
  elsewhere?: Array<{ escrow: Address; consumer: Address; channel: BigNumberish; pendingLive?: boolean; claimed: BigNumberish | null; session?: BigNumberish }>
}
/** @experimental (phase 1) One session the console authorised, or read from SessionAuthorized logs (mandateHash null).
 *  claimedAtPlan: the channel's claimedOf when this mandate's plan first funded it (null: not known). block (review p1m3
 *  recheck 3): the block the plan's facts were read at (the kit writes its pin), or a log's block; null: not known. A
 *  later holderPlan pinned at or before it is pin-not-after-record. */
export interface SessionEntry { chainId: number; escrow: Address; consumer: Address; provider: Address; key: Address; expires: number; mandateHash: Hex | null; claimedAtPlan?: string | null; block?: number | null }
/** @experimental (phase 1) One unsigned transaction of a plan, with its fields in words. */
export interface EscrowPlanStep {
  kind: 'approve' | 'fund' | 'authorizeSession' | 'approve-zero' | 'requestWithdraw' | 'withdraw'
  escrow: Address; token?: Address; provider?: Address; key?: Address; amount?: string; expires?: number; consumer: Address
  tx: TxRequest; summary: string[]
  sendAfter?: number; sendBefore?: number
  /** a withdraw after a request this plan makes: seconds after that request's inclusion */
  sendAfterRequestS?: number; sendBeforeRequestS?: number
}
/** @experimental (phase 1) The holder's transaction plan (pure: no chain read, nothing signed or sent). */
export interface EscrowPlan {
  path: FundingPath
  consumer: Address
  chainId: number
  principal: Address
  agent: Address
  agentKey: Address
  notBefore: number
  expires: number
  /** the mandate's hash when `hub` was given, else null */
  mandateHash: Hex | null
  steps: EscrowPlanStep[]
  /** after the plan the allowance must be 0; `ifNot` is the approve(escrow, 0) to send */
  checks: Array<{ kind: 'check-allowance'; escrow: Address; token: Address; owner: Address; expect: '0'; ifNot: EscrowPlanStep }>
  totals: Array<{ escrow: Address; token: Address; approve: string }>
  /** the entries to record in the session history once the authorizeSession steps were sent; spentElsewhere (review p1m3
   *  recheck) is what the key spent on this mandate's released channels to that provider elsewhere (planApplied compares
   *  the channel with cap − spentElsewhere; the history does not keep it) */
  record: Array<SessionEntry & { spentElsewhere: string }>
  /** container path with a fee: each execute's fee, how many, and their total (smallest unit of the native coin) */
  fees?: { perExecute: string; executes: number; total: string }
  /** review p1m3 recheck 3: whether a session history was given at all ([] is given; left out, key-reused,
   *  funded-elsewhere and channel-session-live were not checked, and a note says so), and whether the mandate's signer
   *  was (holder-changed-since-signing) */
  checked: { history: boolean; signer: boolean }
  notes: string[]
}
/** @experimental (phase 1) The facts escrowPlan checks when given (the kit always gives them). */
export interface EscrowPlanFacts {
  /** the principal's current holder: `holder` must be it (holder-not-current) */
  currentHolder?: Address
  /** container path: the principal has code (principal-not-deployed) and was opened (principal-not-opened) */
  principalDeployed?: boolean
  principalOpened?: boolean
  /** container path: what a simulated execute with the fee answered when it still reverted (execute-reverts) */
  executeReverts?: string | null
  /** container path: the holder's native coin at the pinned block (holder-short-of-fee) */
  holderBalance?: BigNumberish
  /** review p1m3 recheck 3: who signed the mandate (the holder when it was signed); not `holder`, or null (the signature
   *  holds for no address that can be named), is holder-changed-since-signing */
  signer?: Address | null
}
/** @experimental (phase 1) The holder's unsigned transactions for a mandate that names funds: per escrow one exact
 *  approve, a fund per capped provider, an authorizeSession(provider, agentKey, expires) per channel without it, then
 *  the allowance check. Refusals carry data.reason (see the draft, §6.1 S4). */
export declare function escrowPlan(mandate: Mandate, opts: EscrowPlanFacts & { chainId: number; path?: FundingPath; holder?: Address; providers: EscrowPlanProvider[]; allowEscrows?: Address[]; /** container path; needs maxExecuteFee (INVALID_ARGUMENT without it) */ executeFee?: BigNumberish; maxExecuteFee?: BigNumberish; now?: number; history?: SessionEntry[]; hub?: Address; /** the block the facts were read at: the record's block, and pin-not-after-record (review p1m3 recheck 3) */ pinBlock?: number }): EscrowPlan
/** @experimental (phase 1) One channel to close: where it is and what the escrow reports. */
export interface CloseOutChannel { provider: Address; /** null: where the money is is not known (escrow-unknown, R23) */ escrow: Address | null; channel: BigNumberish; pending?: { amount: BigNumberish; requestedAt: BigNumberish } | null }
/** @experimental (phase 1) The close-out of a mandate's channels: requestWithdraw (whole channel) then withdraw inside its window. */
export interface CloseOutPlan {
  path: FundingPath
  consumer: Address
  chainId: number
  principal: Address
  steps: EscrowPlanStep[]
  items: Array<{ provider: Address; escrow: Address; state: 'empty' | 'request' | 'requested' | 'lapsed' | 'replace'; amount?: string; remaining: string; replaces?: { amount: string; requestedAt: number };
    withdrawFrom?: number | { afterRequestS: number }; withdrawUntil?: number | { afterRequestS: number } }>
  fees?: { perExecute: string; executes: number; total: string }
  /** review p1m3 recheck 3: whether a session history was given at all (consumer-unknown is checked only with one) */
  checked: { history: boolean }
  notes: string[]
}
/** @experimental (phase 1) The close-out (also the console's revoke button). Refusals: holder-not-current, execute-fee-too-high, holder-short-of-fee, execute-reverts, consumer-unknown,
 *  escrow-unknown, nothing-to-close. */
export declare function closeOutPlan(mandate: Mandate, opts: { chainId: number; path?: FundingPath; holder?: Address; channels: CloseOutChannel[]; now: number; /** container path; needs maxExecuteFee (INVALID_ARGUMENT without it) */ executeFee?: BigNumberish; maxExecuteFee?: BigNumberish; currentHolder?: Address; executeReverts?: string | null; holderBalance?: BigNumberish; history?: SessionEntry[]; fullRequest?: boolean }): CloseOutPlan
/** @experimental (phase 1) The read-back after a plan was sent. */
export interface PlanApplied { ok: boolean; problems: Array<AgentProblem & { escrow?: Address; provider?: Address; /** channel-not-at-cap only (review p1m3 recheck) */ cause?: 'excess' | 'fund-failed' | 'withdrawn-or-not-sent' | 'spent-unknown' }>; approveZero: EscrowPlanStep[] }
/** @experimental (phase 1) allowance-not-zero, channel-not-at-cap (against cap − the record's spentElsewhere), session-not-set, from readings at a block after the plan. */
export declare function planApplied(plan: EscrowPlan, mandate: Mandate, readings: { allowances: Array<{ escrow: Address; allowance: BigNumberish }>; channels: Array<{ provider: Address; channel: BigNumberish; session: BigNumberish; claimed?: BigNumberish }> }): PlanApplied
/** @experimental (phase 1) One session entry, checked and checksummed. */
export declare function sessionEntry(e: SessionEntry): SessionEntry
/** @experimental (phase 1) The console's session history (plain JSON entries, kept by the caller). */
export interface SessionHistory { record(entries: SessionEntry | SessionEntry[]): void; entries(): SessionEntry[] }
/** @experimental (phase 1) A new session history, from entries kept earlier. */
export declare function sessionHistory(initial?: SessionEntry[]): SessionHistory

// ---- phase 1, M4 (experimental): the agent runtime's spend limiter / 代理运行时的花费限额器 ----
/** @experimental (phase 1, M4) The reasons spendDecision refuses, in its order. */
export declare const SPEND_REFUSALS: readonly string[]
/** @experimental (phase 1, M4) The reasons that stop an order for good. */
export declare const SPEND_STOPS: readonly string[]
/** @experimental (phase 1) The default per-call price ceiling, in percent of the (mandate, provider) cap, rounded down to the token's smallest unit (10); a default of 0 is none: maxCallPrice must be set. */
export declare const SPEND_DEFAULT_CALL_PRICE_PERCENT: 10
/** @experimental (phase 1, M4) The version of a spend record (1). */
export declare const SPEND_RECORD_VERSION: 1
/** @experimental (phase 1, M4) One capped provider's channel as the start pinned it: base is its claimedOf then, hi the highest cumulative signed. */
export interface SpendPin { provider: Address; escrow: Address; token: Address; cap: string; base: string; hi: string }
/** @experimental (phase 1, M4) The record the limiter keeps per agent key (plain JSON). */
export interface SpendRecord { v: 1; chainId: number; agentKey: Address; seq: number; state: 'accepted' | 'started'; mandateHash: Hex | null; consumer: Address | null; notBefore: number | null; expires: number | null; stopped: null | { reasons: string[]; at: number | null }; providers: SpendPin[] }
/** @experimental (phase 1, M4) Check and normalise a spend record (INVALID_ARGUMENT). */
export declare function spendRecord(r: unknown): SpendRecord
/** @experimental (phase 1, M4) The record an ok escrow-channel check starts (AGENT_SPEND_REFUSED spend-not-enforced otherwise). */
export declare function spendPin(check: EscrowChannelMandateCheck | MandateCheck, opts: { chainId: number; agentKey?: Address }): SpendRecord
/** @experimental (phase 1, M4) The limiter's rule for one voucher: allowed, or the first refusal of SPEND_REFUSALS. */
export type SpendDecision = { ok: true; hi: string; spent: string; remaining: string } | { ok: false; refused: string; stop: boolean; message: string }
/** @experimental (phase 1, M4) May the agent key sign this voucher (pure). `maxPrice` is the per-call price ceiling for this provider (at most its cap: spend-call-price-ceiling-above-cap); without it the ceiling is SPEND_DEFAULT_CALL_PRICE_PERCENT of the cap, rounded down, and 0 is spend-call-price-ceiling-unset; a price above the ceiling is spend-call-price-above-ceiling (none of the three stops the order). */
export declare function spendDecision(record: SpendRecord, request: { chainId: number; provider: Address; escrow: Address; consumer: Address; cumulative: BigNumberish; price: BigNumberish; now: number; maxPrice?: BigNumberish | null }): SpendDecision
/** @experimental (phase 1, M4) A later check against the record: the stops, the check's problems, hi raised to what was settled (pure). */
export declare function spendRecheck(record: SpendRecord, check: EscrowChannelMandateCheck | MandateCheck): { ok: boolean; stop: string[]; problems: string[]; hi: string[] }
/** @experimental (phase 1, M4) A payer wrapped by the limiter: reserve refuses with AGENT_SPEND_REFUSED (data.reason) and adds mandateHash to the voucher. */
export interface LimitedPayer {
  readonly consumer: Address
  readonly signer: Address
  readonly mandateLimited: true
  cumulativeOf(svc: unknown): bigint
  inflightOf(svc: unknown): number | undefined
  setCumulative(svc: unknown, value: BigNumberish): Promise<void>
  resync(svc: unknown, last: BigNumberish, evidence?: { voucher?: Record<string, unknown> }): Promise<bigint>
  reserve(svc: unknown, price: BigNumberish): Promise<{ voucher: Record<string, unknown>; next: bigint; amount: bigint; spent: string; remaining: string; commit(): Promise<void>; release(): void }>
  voucherFor(svc: unknown, price: BigNumberish): Promise<Record<string, unknown>>
}
/** @experimental (phase 1, M4) The agent runtime's spend limiter: one record per agent key; a key without its record never signs. */
export interface SpendLimiter {
  accept(o: { chainId: number; agentKey: Address }): Promise<SpendRecord>
  /** the record a check starts; for the same mandate again the start is kept (base never moves) and hi is raised to the claimedOf read now; a stopped record is spend-stopped, a check of another escrow or consumer stops it */
  start(o: { chainId: number; check: EscrowChannelMandateCheck | MandateCheck }): Promise<SpendRecord>
  recheck(o: { chainId: number; check: EscrowChannelMandateCheck | MandateCheck }): Promise<{ ok: boolean; stop: string[]; problems: string[]; hi: string[]; stopped: SpendRecord['stopped'] }>
  record(o: { chainId: number; agentKey: Address }): Promise<SpendRecord | null>
  stop(o: { chainId: number; agentKey: Address; reason?: string }): Promise<SpendRecord>
  /** @experimental (phase 1, restart) seal the agent key's secret with the limiter's vault and keep only the blob (the record must exist and not be stopped) */
  keepKey(o: { chainId: number; agentKey: Address; secret: Hex }): Promise<true>
  /** @experimental (phase 1, restart) after a restart: the record, the sealed key opened and matched (spendResume), and for a started record the fresh `check` compared as recheck does; refuses AGENT_SPEND_REFUSED (SPEND_RESUME_REFUSALS, or the stop the check finds) */
  resume(o: { chainId: number; agentKey: Address; check?: EscrowChannelMandateCheck | MandateCheck | null }): Promise<{ record: SpendRecord; secret: Hex; recheck: null | { ok: boolean; stop: string[]; problems: string[]; hi: string[]; stopped: SpendRecord['stopped'] } }>
  /** @experimental (phase 1, restart) destroy the sealed key (the order ended); every stop destroys it too */
  forgetKey(o: { chainId: number; agentKey: Address }): Promise<void>
  payer(o: { chainId: number; payer: { consumer: Address; signer: Address; reserve: Function; cumulativeOf: Function; [k: string]: unknown }; maxPrice?: BigNumberish | Record<string, BigNumberish> | null; signed?: { mandate: Record<string, unknown>; sig: Hex } }): LimitedPayer
}
/**
 * @experimental (phase 1, M4) A store of spend records: strings, may be async. One writer per record is the premise; a
 * store shared by several limiters closes the race between them only if set honours `ifSeq` (compare-and-set): write when
 * the stored record's seq equals ifSeq (null: none stored) and return false otherwise. A stop is kept under `<key>:stopped`
 * too, which no writer of the record can erase.
 */
export interface SpendStore { get(key: string): unknown; set(key: string, value: string, opts?: { ifSeq: number | null }): unknown; delete?(key: string): unknown }
/** @experimental (phase 1, M4) A new spend limiter; `store` holds its records (default memory, compare-and-set); with `vault` (phase 1, restart) it can keep each agent key sealed in the store and resume an order after a restart. */
export declare function createSpendLimiter(opts?: { store?: SpendStore; clock?: () => number; vault?: KeyVault }): SpendLimiter
/** @experimental (phase 1, restart) The reasons spendResume refuses, in its order. */
export declare const SPEND_RESUME_REFUSALS: readonly string[]
/** @experimental (phase 1, restart) May an order resume with the key its vault opened (pure): key is the address it opens to, 'missing' or 'unreadable'. */
export declare function spendResume(record: SpendRecord | null, request: { chainId: number; agentKey: Address; key: Address | 'missing' | 'unreadable'; mandateHash?: Hex | null }): { ok: true } | { ok: false; refused: string; message: string }

// ---- phase 1, restart (experimental): the key vault an agent runtime keeps its session keys in / 钥匙保险箱 ----
/**
 * @experimental (phase 1) A key vault: the operator's (a passphrase, a key of its own, a KMS). seal returns what the store
 * may keep (never the plaintext); open returns the bytes, or throws (AGENT_KEY_VAULT for the SDK's vault) and never
 * yields bytes it could not authenticate. `context` binds a blob to what it was sealed for (the limiter: chain and key).
 */
export interface KeyVault {
  seal(bytes: Uint8Array, opts: { context: string }): Promise<string> | string
  open(blob: string, opts: { context: string }): Promise<Uint8Array> | Uint8Array
}
/** @experimental (phase 1) The version of a key-vault blob (1). */
export declare const KEY_VAULT_VERSION: 1
/** @experimental (phase 1) scrypt's parameters, fixed: N 2^17, r 8, p 1, 32 bytes. */
export declare const KEY_VAULT_SCRYPT: Readonly<{ N: number; r: number; p: number; dkLen: number }>
/** @experimental (phase 1) The salt of a key-vault blob, in bytes (16). */
export declare const KEY_VAULT_SALT_BYTES: 16
/** @experimental (phase 1) The XChaCha20-Poly1305 nonce of a key-vault blob, in bytes (24). */
export declare const KEY_VAULT_NONCE_BYTES: 24
/** @experimental (phase 1) The shortest passphrase passphraseKeyVault takes, in UTF-8 bytes (12). */
export declare const KEY_VAULT_MIN_PASSPHRASE: 12
/** @experimental (phase 1) Every blob of version 1 starts with it. */
export declare const KEY_VAULT_PREFIX: 'tapeapi-key-vault:v1:'
/** @experimental (phase 1) A vault on a passphrase: scrypt (KEY_VAULT_SCRYPT) + XChaCha20-Poly1305, random salt and nonce. */
export declare function passphraseKeyVault(opts: { passphrase: string }): KeyVault & { readonly kind: 'passphrase' }
/** @experimental (phase 1) scrypt(passphrase, salt) with KEY_VAULT_SCRYPT. */
export declare function keyVaultKey(passphrase: string, salt: Uint8Array): Promise<Uint8Array>
/** @experimental (phase 1) The blob of `plaintext` sealed with a 32-byte key, salt and nonce for `context` (pure). */
export declare function keyVaultSeal(key: Uint8Array, opts: { salt: Uint8Array; nonce: Uint8Array; context: string; plaintext: Uint8Array }): string
/** @experimental (phase 1) The plaintext of a blob (pure); AGENT_KEY_VAULT key-vault-malformed or key-vault-open-failed otherwise. */
export declare function keyVaultOpen(key: Uint8Array, blob: string, opts: { context: string }): Uint8Array
/** @experimental (phase 1) A blob taken apart (AGENT_KEY_VAULT key-vault-malformed otherwise). */
export declare function keyVaultParse(blob: string): { salt: Uint8Array; nonce: Uint8Array; sealed: Uint8Array }
/** @experimental (phase 1) The associated data of a blob sealed for `context`. */
export declare function keyVaultAad(context: string): Uint8Array
/** @experimental (phase 1) The context the spend limiter seals an agent key for: tapeapi-spend-key/v1/<chainId>/<agentKey, lower case>. */
export declare function spendKeyContext(chainId: number, agentKey: Address): string

// ---- phase 1, M7 (experimental): the spend statement of a delivery and its reconciliation / 交付的花费说明与对账 ----
/** @experimental (phase 1, M7) The problems spendEvidence reports, in its order. */
export declare const SPEND_EVIDENCE_PROBLEMS: readonly string[]
/** @experimental (phase 1, M7) The warnings spendEvidence may report (never problems: the reconciliation is approximate). */
export declare const SPEND_EVIDENCE_WARNINGS: readonly string[]
/** @experimental (phase 1, M7) One entry of the `spend` member of a deliver result: what one capped channel paid since the
 *  check that started the work (claimedOf at delivery − claimedOf then), decimal strings. Settlement may lag up to 48 hours,
 *  so for an honest agent on a channel only this mandate uses, `spent` at delivery is at most what the agent key authorised
 *  (a lower bound of it). The statement is the agent's own word: a dishonest agent can state less, and only the verifier's
 *  own `claimedNow` is its reading of the chain. */
export interface SpendStatementEntry { provider: Address; escrow: Address; claimedAtStart: string; claimedAtDelivery: string; spent: string }
/** @experimental (phase 1, M7) The agent's statement from its started record and its last check before the delivery
 *  (pure); a provider without a reading on the pinned escrow for the pinned consumer is left out, never made up. */
export declare function spendStatement(record: SpendRecord, check: EscrowChannelMandateCheck | MandateCheck): SpendStatementEntry[]
/** @experimental (phase 1, M7) One reconciled entry: claimedNow / spentNow from the verifier's reading on the same escrow,
 *  expected = the receipted ok calls × the providers' prices, reconciled against spentNow (else spent). */
export interface SpendEvidenceItem extends SpendStatementEntry { claimedNow: string | null; spentNow: string | null; calls: number; expected: string | null; reconciled: 'equal' | 'above' | 'below' | null }
/** @experimental (phase 1, M7) A delivery's spend statement reconciled (pure): problems for a malformed statement, a
 *  provider without a cap or amounts that do not add up; every mismatch with the chain or the receipts is a warning. */
export declare function spendEvidence(spend: unknown, opts: { mandate: Mandate | NormalizedMandate; calls?: Array<{ provider: Address; method: string; ok: boolean }>; readings?: Array<Pick<ChannelReading, 'provider' | 'escrow' | 'claimedAtCheck'>> | null; prices?: Record<string, Record<string, string>> | null }): { ok: boolean; problems: AgentProblem[]; warnings: AgentProblem[]; items: SpendEvidenceItem[] }
