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
export interface AgentTypedData { domain: { name: string; version: string; chainId: number; verifyingContract: Address }; types: Record<string, Array<{ name: string; type: string }>>; primaryType: string; message: Record<string, unknown>; warnings?: string[]; display?: { task?: Record<string, unknown>; notBefore?: string | null; expires?: string | null } }
/** @experimental What goes to the wallet (the four keys only) and what the console shows. */
export interface WalletRequest { payload: { domain: AgentTypedData['domain']; types: AgentTypedData['types']; primaryType: string; message: Record<string, unknown> }; warnings: string[]; display?: AgentTypedData['display'] }
/** @experimental Split a typed-data result of this subpath into the wallet payload and the console's warnings and display.
 *  The input must be exactly what this module builds; warnings and display are recomputed, never passed through.
 *  `expect` ({ chainId, hub }) is required: the chain and hub the holder's console expects (a domain rebuilt from itself
 *  cannot reveal a changed chainId). The holder's defence is still the fields the wallet shows. */
export declare function forWallet(td: AgentTypedData, expect: { chainId: number; hub: Address }): WalletRequest
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
/** @experimental shown with an offer whose fee is not 0 */
export declare const OFFER_FEE_WARNING: string

/** @experimental keccak256(UTF-8(canonicalJSON(task))) */
export declare function taskHashOf(task: Record<string, unknown>): Hex
/** @experimental keccak256(UTF-8(canonicalJSON(value))) */
export declare function jsonHashOf(value: unknown): Hex
/** @experimental */
export declare function normalizeMandate(m: Mandate): NormalizedMandate
/** @experimental */
export declare function hashScope(s: MandateScope): Uint8Array
/** @experimental */
export declare function hashMandate(m: Mandate): Uint8Array
/** @experimental the digest the holder signs; also the mandate's identity */
export declare function mandateDigest(chainId: number, hub: Address, m: Mandate): Uint8Array
/** @experimental mandateDigest as 0x hex: the thread key */
export declare function mandateHashOf(chainId: number, hub: Address, m: Mandate): Hex
/** @experimental */
export declare function mandateTypedData(chainId: number, hub: Address, m: Mandate, opts?: FundsGate & { task?: Record<string, unknown> }): AgentTypedData
/** @experimental signs with a local key (tests, scripts); a wallet signs mandateTypedData instead */
export declare function signMandate(chainId: number, hub: Address, m: Mandate, privateKey: Hex | Uint8Array, opts?: FundsGate): Hex
/** @experimental */
export declare function normalizeTaskOffer(o: TaskOffer): TaskOffer & { fee: string; nonce: string }
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
/** @experimental */
export declare function normalizeTaskVerdict(v: TaskVerdict): Required<TaskVerdict>
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
export declare function normalizeMandateRevocation(r: MandateRevocation): MandateRevocation
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
/** @experimental A container read from the chain: the on-chain name (or null), never a manifest's `name`. */
export interface ContainerIdentity { container: Address; chainId: number; circuits: Address; tokenId: string; holder: Address; name: string | null }
/** @experimental */
export interface RevocationList { status: 'published' | 'none-published' | 'invalid'; issued?: number; revokedBefore?: number; mandateHashes?: Hex[]; reason?: string }
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
/** @experimental */
export interface EvidenceCheck {
  ok: boolean
  enforcement: 'none'
  problems: AgentProblem[]
  proves: string
  doesNotProve: string[]
  receipts: Array<{ container: Address; name: string | null; method: string; ts: number; ok: boolean; answeredBy: boolean }>
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
  revoked: { at: number; via: 'site' | 'message' } | null
  /** Delivered and no verdict before the delivery's own exp (there is no arbiter) */
  unaccepted: boolean
}
/** @experimental */
export interface AgentKitOptions {
  clock?: () => number
  revocationFloor?: { get(key: string): unknown; set(key: string, value: number): unknown }
  /** a Map, or a store whose setIfAbsent stores the value only when the key is absent and returns the previous value, in one step */
  nonces?: Map<string, string> | { setIfAbsent(key: string, value: string): string | undefined | Promise<string | undefined> }
  resolve?: (container: Address) => Promise<any>
}
/** @experimental */
export interface AgentKit {
  /** agentKey / agent: when given, the mandate must name exactly these, and a mismatch keeps the nonce unrecorded; without
   *  them nothing is compared and the nonce is recorded when the other checks allow it */
  verifyMandate(signed: { mandate: Mandate; sig: Hex }, opts?: { agentKey?: Address; agent?: Address; at?: number; readSite?: boolean; revocations?: Array<{ revocation: MandateRevocation; sig: Hex }> }): Promise<MandateCheck>
  verifyTaskThread(messages: ThreadMessage[], opts?: { at?: number; readSite?: boolean }): Promise<ThreadCheck>
  verifyEvidence(deliver: { receipts: unknown[]; receiptsHash: Hex }, opts: { mandate: Mandate }): Promise<EvidenceCheck>
  readRevocations(principal: Address): Promise<RevocationList>
  identityOf(container: Address): Promise<ContainerIdentity>
  chainId: number
  hub: Address
}
/** @experimental Container-agent checks bound to one client (rpcUrls required; decisions read under strict agreement). */
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
  /** only the unedited result of transferToContainer of this kit; anything else is recipient-not-from-chain */
  viaContainer(o: { from: Address; tx: UnsignedPayment }): UnsignedPayment
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
