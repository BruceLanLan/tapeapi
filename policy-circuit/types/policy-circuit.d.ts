// @tapeapi/policy-circuit: policy circuits after the Policy Circuit Gate TAP draft (TAPs pull request #84, not merged).
// The WHOLE package is experimental (version 0.1.0) and may change or go away in any release. It is an off-chain check:
// it constrains only the parties that check it, the agent's wallet may ignore it, and it is not a signing guardrail.
// Bindings to a mandate or an escrow session are `conditional` at best, never `true`. Nothing is deployed for it.
// 整个包都是实验性的（0.1.0）。它是链下核查：只约束去核查它的一方，代理的钱包可以不理会它，它不是签名护栏。
import type { Address, Hex, TapeAPIError } from '@tapeapi/sdk'

/** A non-negative integer: a decimal string, a bigint, or a SAFE JS integer (an unsafe number is refused, never rounded). */
export type PolicyInt = string | bigint | number

/** @experimental A rule of the draft was broken; `code` is the draft's problem name. */
export declare class PolicyCircuitError extends Error {
  constructor(code: string, detail?: string)
  readonly name: 'PolicyCircuitError'
  readonly code: string
  readonly detail: string
}

// ---- §2 policy circuits ----
/** @experimental The pin convention, "tap-policy/1". */
export declare const POLICY_CONVENTION: 'tap-policy/1'
/** @experimental 128 input pins (the request word). */
export declare const POLICY_N_IN: 128
/** @experimental 8 output pins (allow bit and a 7-bit reason). */
export declare const POLICY_N_OUT: 8
/** @experimental At most 49,152 bytes, checked before parsing. */
export declare const MAX_POLICY_BYTES: 49152
/** @experimental Reason codes 0-7 by name. */
export declare const POLICY_REASONS: Readonly<Record<0 | 1 | 2 | 3 | 4 | 5 | 6 | 7, string>>
/** @experimental The display name of a reason code: a name for 0-7, 'reserved' for 8-63, 'policy-defined' for 64-127. */
export declare function policyReasonName(reason: number): string
/** @experimental `0x` + SHA-256 of the whole file. */
export declare function policyNetlistHash(data: Uint8Array): Hex

/** @experimental The facts of a checked policy file. */
export interface PolicyCircuitInfo {
  netlistHash: Hex
  stateful: boolean
  bytes: number
  nand: number
  latch: number
  /** ceil(latch / 8): the size of the state a gatekeeper keeps. */
  stateBytes: number
  nIn: number
  nOut: number
}
/** @experimental A checked, parsed policy: cache it by netlistHash. */
export interface PolicyCircuit extends PolicyCircuitInfo {
  zeroState(): Uint8Array
  /** One TAP-02 beat. Build `word` with policyRequestWord; never take one from a requester. */
  step(state: Uint8Array, word: Uint8Array): { state: Uint8Array; outputs: Uint8Array }
}
/** @experimental §2.2. Throws PolicyCircuitError policy-too-large, policy-invalid-file, policy-bad-pins, policy-stateful-mismatch. */
export declare function checkPolicyCircuit(data: Uint8Array, opts?: { declaredStateful?: boolean | null }): PolicyCircuitInfo
/** @experimental Check once and keep a handle. */
export declare function loadPolicyCircuit(data: Uint8Array, opts?: { declaredStateful?: boolean | null }): PolicyCircuit

/** @experimental A verdict: only `allow` with reason 0 lets a request through. */
export interface PolicyVerdict {
  verdict: 'allow' | 'deny'
  reason: number
  reasonName?: string
  /** The allow bit was set with a reason: an invalid result, denied. */
  invalidResult?: true
}
/** @experimental §2.3: exactly 0x01 allows; every other value denies. */
export declare function interpretPolicyOutput(outputs: Uint8Array): PolicyVerdict

// ---- §3 tables, requests, the word ----
/** @experimental Request kinds 0-4 by name (5-7 reserved). */
export declare const POLICY_KINDS: Readonly<Record<0 | 1 | 2 | 3 | 4, 'other' | 'pay' | 'fund' | 'call' | 'transfer'>>
/** @experimental One listed asset (§3.1): its class and its own unit. */
export interface PolicyAssetEntry {
  /** 1-255. */
  class: number
  /** Base units of this asset per amount unit, [1, 2^256): a decimal string without sign or leading zero (never a number). */
  unit: string
}
/** @experimental The tables of a binding (JSON): lowercase addresses to `{ class, unit }` for assets and to classes 1-255 for counterparties. An asset not listed has no class and no unit (its requests overflow). */
export interface PolicyTables {
  assets: Record<string, PolicyAssetEntry>
  counterparties: Record<string, number>
}
/** @experimental A request, as the gatekeeper presents it. */
export interface PolicyRequest {
  /** [0, 2^256) base units of `asset`. */
  amount: PolicyInt
  asset: Address
  counterparty: Address
  /** 0-7 (§3.4). */
  kind: number
  /** [0, 2^64): the gatekeeper's time, Unix seconds. */
  ts: PolicyInt
}
/** @experimental The fields of the request word. */
export interface PolicyWordFields { amount: number; overflow: 0 | 1; asset: number; counterparty: number; kind: number; day: number; hour: number; weekday: number }
/** @experimental §3.1 (tables-malformed). */
export declare function checkPolicyTables(tables: unknown): { assets: Map<string, { class: number; unit: bigint }>; counterparties: Map<string, number> }
/** @experimental keccak256(utf8(canonicalJSON(tables))). */
export declare function policyTablesHash(tables: PolicyTables): Hex
/** @experimental §3.2 (request-malformed). */
export declare function checkPolicyRequest(request: unknown): { amount: bigint; asset: string; counterparty: string; kind: number; ts: bigint }
/** @experimental §3.3: the fields (the amount in the request's own asset's unit, rounded up, saturated with `overflow`; an unlisted asset overflows). */
export declare function policyRequestFields(request: PolicyRequest, tables: PolicyTables): PolicyWordFields
/** @experimental §3.3: the 16-byte request word. */
export declare function policyRequestWord(request: PolicyRequest, tables: PolicyTables): Uint8Array
/** @experimental For display only (word-malformed, word-reserved-bits). */
export declare function decodePolicyWord(word: Uint8Array): PolicyWordFields

// ---- §4 evaluation ----
/** @experimental One evaluated request; `word`, `outputs`, `newState` in 0x-hex. */
export interface PolicyEvaluation extends PolicyVerdict { word: Hex; outputs: Hex; newState?: Hex; amount?: string }
/** @experimental §4.1: one request; a stateful policy takes the gatekeeper's state (zero when absent). */
export declare function evaluatePolicyRequest(circuit: PolicyCircuit, request: PolicyRequest, tables: PolicyTables, state?: Uint8Array | Hex | null): PolicyEvaluation
/** @experimental evalFile semantics: combinational policies only (policy-stateful). */
export declare function evalPolicyFile(circuit: PolicyCircuit, request: PolicyRequest, tables: PolicyTables): PolicyEvaluation
/** @experimental One trace entry: a request, or with escrowCumulative a request without amount and the voucher's cumulative. */
export interface PolicyTraceEntry { request: Omit<PolicyRequest, 'amount'> & { amount?: PolicyInt }; cumulative?: PolicyInt; verdict?: 'allow' | 'deny' }
/** @experimental §4.2: replay from the zero state; throws on the first bad entry (trace-*). */
export declare function replayPolicyTrace(circuit: PolicyCircuit, tables: PolicyTables, entries: PolicyTraceEntry[], opts?: { notBefore?: PolicyInt | null; expires?: PolicyInt | null; escrowCumulative?: boolean }): { results: PolicyEvaluation[]; finalState: Hex | null; allowed: number }

// ---- §5 bindings ----
/** @experimental The TAP-11 hub, the verifyingContract of every binding. */
export declare const POLICY_HUB: Address
export declare const POLICY_BINDING_TYPE: string
export declare const POLICY_REVOCATION_TYPE: string
export declare const POLICY_BINDING_TYPEHASH: Hex
export declare const POLICY_REVOCATION_TYPEHASH: Hex
/** @experimental 1 mandate, 2 escrow-session, 3 account, 4 label. */
export declare const POLICY_SUBJECT_KINDS: Readonly<Record<1 | 2 | 3 | 4, 'mandate' | 'escrow-session' | 'account' | 'label'>>
/** @experimental 24. */
export declare const MAX_REVOKED_POLICY_HASHES: number
/** @experimental 604,800 s (7 days): the window proposed by default. */
export declare const POLICY_BINDING_DEFAULT_WINDOW_S: number
/** @experimental 2,592,000 s (30 days): the longest window a tool may propose by default. */
export declare const POLICY_BINDING_MAX_DEFAULT_WINDOW_S: number

/** @experimental A PolicyBinding in its JSON form (integers below 2^53 as numbers, otherwise decimal strings). */
export interface PolicyBinding { netlistHash: Hex; subjectKind: number | string; subject: Hex; tablesHash: Hex; notBefore: PolicyInt; expires: PolicyInt; issued: PolicyInt }
/** @experimental A PolicyBindingRevocation. */
export interface PolicyBindingRevocation { bindingHashes: Hex[]; revokedBefore: PolicyInt; issued: PolicyInt }
/** @experimental A revocation as carried: its signer is recovered from `sig`. */
export interface PolicyRevocationEntry { revocation: PolicyBindingRevocation; sig?: Hex | null }
/** @experimental A subject value. */
export interface PolicySubject { subjectKind: 1 | 2 | 3 | 4; subject: Hex }
/** @experimental A #59 / #60 escrow channel session (never an x402-batch channel). */
export interface PolicyEscrowSession { escrow: Address; consumer: Address; provider: Address; key: Address; expires?: number; [k: string]: unknown }

export declare function policyDomainSeparator(chainId: number): Hex
export declare function policyBindingHash(chainId: number, binding: PolicyBinding): Hex
export declare function policyRevocationHash(chainId: number, revocation: PolicyBindingRevocation): Hex
/** @experimental §5.2 static rules (throws the draft's problem). */
export declare function checkPolicyBindingForm(binding: unknown): void
export declare function checkPolicyRevocationForm(revocation: unknown): void
/** @experimental §5.4: listed, or issued strictly below revokedBefore. */
export declare function policyRevocationCovers(revocation: PolicyBindingRevocation, bindingHash: Hex, issued: PolicyInt): boolean
/** @experimental Subject values. escrowSession refuses an x402-batch channel (INVALID_ARGUMENT, data.reason 'policy-subject-x402'). */
export declare const policySubject: {
  mandate(hashOrMandate: Hex | Record<string, unknown>, opts?: { chainId?: number }): PolicySubject
  escrowSession(session: PolicyEscrowSession): PolicySubject
  account(address: Address): PolicySubject
  label(text: string): PolicySubject
}

/** @experimental What a binding check says (§5.3), plus TapeAPI's display text. */
export interface PolicyBindingResult {
  bindingHash: Hex
  signer: Address | null
  subjectKind: 'mandate' | 'escrow-session' | 'account' | 'label'
  status: 'ok' | 'problems'
  problems: string[]
  binderChecked: boolean
  fileChecked: boolean
  displayOnly: boolean
  /** false for a label; null when the binder was not checked; false on a problem or without a checked file;
   *  'conditional' for kinds 1 and 2 (fixed: never true); true for kind 3. */
  enforceable: true | false | null | 'conditional'
  display: { en: string; zh: string }
}
/** @experimental Options of the binding checks. */
export interface PolicyBindingCheckOptions {
  /** The verifier's Unix time. */
  now: PolicyInt
  /** The policy file at hand; without it there is no verdict. */
  policyFile?: Uint8Array | null
  /** Report policy-file-unavailable (a gatekeeper could not obtain the file). */
  fileUnavailable?: boolean
  declaredStateful?: boolean | null
  revocations?: PolicyRevocationEntry[] | null
  /** Kind 1: the mandate (it must hash to the subject); the binding window must fit inside it. */
  mandate?: Record<string, unknown> | null
  /** Kind 2: the session (it must be the subject); the binding must not outlive it. */
  session?: PolicyEscrowSession | null
}
/** @experimental A binder reader: who the binder is, and EIP-1271 for a contract binder. */
export interface PolicyBinderReader {
  resolve(subjectKind: number, subject: Hex, ctx: { chainId: number; mandate: Record<string, unknown> | null; session: PolicyEscrowSession | null }): Promise<{ binder: Address | null; pinned?: { number?: number; hash: Hex } | null } | Address | null>
  isValidSignature?(address: Address, digest: Hex, sig: Hex, pinned: { number?: number; hash: Hex } | null): Promise<boolean>
}
/** @experimental §5.3, synchronous, ECDSA binders: `binder` is the address the subject kind requires. */
export declare function checkPolicyBinding(chainId: number, binding: PolicyBinding, sig: Hex | null | undefined, tables: PolicyTables, opts: PolicyBindingCheckOptions & { binder?: Address | null }): PolicyBindingResult
/** @experimental §5.3 with a binder reader (EIP-1271 for contract binders); a missing or failed read is binderChecked: false. */
export declare function verifyPolicyBinding(chainId: number, binding: PolicyBinding, sig: Hex | null | undefined, tables: PolicyTables, opts: PolicyBindingCheckOptions & { binder?: Address | PolicyBinderReader | null }): Promise<PolicyBindingResult & { binder: Address | null; eip1271: boolean; binderError: string | null }>
/** @experimental §5.4: the later issued wins; a tie with different hashes is binding-ambiguous. */
export declare function choosePolicyBinding<T extends { binding: PolicyBinding; result: PolicyBindingResult }>(entries: T[]): { chosen: T | null; problem: null | 'binding-ambiguous' | 'binding-unusable' }

/** @experimental eth_signTypedData_v4 payload for the binder's console (this package signs nothing). */
export interface PolicyTypedData<M> {
  domain: { name: 'TapeAPI'; version: '1'; chainId: number; verifyingContract: Address }
  types: Record<string, Array<{ name: string; type: string }>>
  primaryType: 'PolicyBinding' | 'PolicyBindingRevocation'
  message: M
}
export declare function policyBindingTypedData(chainId: number, input: Omit<PolicyBinding, 'tablesHash' | 'notBefore' | 'expires' | 'issued'> & { tablesHash?: Hex; tables?: PolicyTables; notBefore?: PolicyInt; expires?: PolicyInt; issued?: PolicyInt }, opts?: { now?: PolicyInt }): PolicyTypedData<PolicyBinding> & { binding: PolicyBinding; bindingHash: Hex; longWindow: boolean; display: { en: string; zh: string } }
export declare function policyRevocationTypedData(chainId: number, input?: { bindingHashes?: Hex[]; revokedBefore?: PolicyInt; issued?: PolicyInt }, opts?: { now?: PolicyInt }): PolicyTypedData<PolicyBindingRevocation> & { revocation: PolicyBindingRevocation; revocationHash: Hex }

// ---- §6 metadata members ----
export declare function checkTokenPolicyMember(tap: unknown): { convention: 'tap-policy/1'; stateful: boolean; reasons?: Record<string, string> }
export declare function checkSubjectPolicyMember(member: unknown): { chainId: PolicyInt; binding: PolicyBinding; sig: Hex; tables: PolicyTables; policy?: { chainId: PolicyInt; contract: Address; tokenId: PolicyInt } }

// ---- the gatekeeper ----
export declare const POLICY_TRACE_VERSION: 1
/** @experimental A trace store: append-only text of JSON lines. */
export interface PolicyTraceStore { read(): string; append(text: string): void; lock?(): Promise<() => void> }
export declare function memoryPolicyTraceStore(): PolicyTraceStore
/** @experimental A file store (mode 600, with a lock file when fs has writeFileSync and unlinkSync). */
export declare function policyTraceFileStore(path: string, fs: { readFileSync: Function; appendFileSync: Function; writeFileSync?: Function; unlinkSync?: Function; chmodSync?: Function }, opts?: { staleMs?: number; waitMs?: number }): PolicyTraceStore & { path: string }
/** @experimental A binder reader on an SDK client (siteStatus at a TAP-10 pinned block) and its quorum RPC client (EIP-1271, strict). */
export declare function policyBinderFromApi(api: { siteStatus(target: unknown): Promise<unknown> }, opts?: { rpc?: { call(method: string, params?: unknown[], opts?: unknown): Promise<any>; ethCall(to: Address, data: Hex, block?: unknown, opts?: unknown): Promise<Hex>; tap10Block(opts: { maxLag: number }): Promise<{ hash: Hex }> } | null; chainId?: number }): PolicyBinderReader

/** @experimental A gatekeeper's decision. Serve or settle only on verdict 'allow'. */
export interface PolicyGateDecision extends Partial<PolicyEvaluation> {
  verdict: 'allow' | 'deny'
  /** The first reason a request was refused before or instead of a policy verdict (a problem of the draft or of TapeAPI). */
  problem?: string
  problems: string[]
  bindingHash: Hex | null
  ts?: number
  /** The amount presented to the policy (for kind 2, the cumulative delta). */
  amount?: string
  enforceable?: true | 'conditional'
  detail?: string
}
/** @experimental A gatekeeper for one subject. */
export interface PolicyGate {
  admit(request: { amount?: PolicyInt; cumulative?: PolicyInt; asset: Address; counterparty: Address; kind: number }): Promise<PolicyGateDecision>
  trace(): PolicyTraceEntry[]
  startTrace(opts: { reason: string }): Promise<{ started: true; bindingHash: Hex } | PolicyGateDecision>
  status(): { open: boolean; problem: string | null; bindingHash: Hex | null; enforceable: PolicyBindingResult['enforceable']; binding: PolicyBindingResult | null; stateful: boolean | null; traceStarted: boolean; traceProblem: string | null; display: { en: string; zh: string } | null }
}
/**
 * @experimental Create a gatekeeper (fails closed in every row of the draft's §7). A kind-2 (escrow-session) binding
 * needs `session`: without it this rejects with TapeAPIError INVALID_ARGUMENT, data.reason 'policy-session-required'
 * (its subject is only a hash, so an x402 channel could not be told apart). The binder is resolved again before every
 * decision (EIP-1271 asked at that read's pinned block), so a transfer of the circuit ends the earlier holder's bindings
 * at the next decision (`not-signed-by-binder`), and a failed read denies (`binder-not-checked`).
 */
export declare function createPolicyGate(opts: {
  chainId: number
  binding?: PolicyBinding
  sig?: Hex | null
  bindings?: Array<{ binding: PolicyBinding; sig: Hex | null }>
  tables: PolicyTables
  policyFile?: Uint8Array
  fetchPolicyFile?: (netlistHash: Hex) => Promise<Uint8Array | null>
  binder?: Address | PolicyBinderReader | null
  revocations?: PolicyRevocationEntry[] | (() => PolicyRevocationEntry[] | Promise<PolicyRevocationEntry[]>)
  store?: PolicyTraceStore
  clock?: () => number
  mandate?: Record<string, unknown> | null
  /** Required for a kind-2 binding (`policy-session-required` without it). */
  session?: PolicyEscrowSession | null
  declaredStateful?: boolean | null
}): Promise<PolicyGate>

/** @experimental Errors that are not the draft's problems are TapeAPIError (INVALID_ARGUMENT). */
export type PolicyCircuitArgumentError = TapeAPIError
