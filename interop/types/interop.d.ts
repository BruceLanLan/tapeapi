// @tapeapi/interop: visitor grants between apps. The WHOLE package is Experimental and outside the package's
// compatibility promise (2.x): it is a PROTOTYPE, not a TAP, whose format text is spec/TAPI-28.md (Experimental; where the
// two differ, the code is authoritative); no service knows the format.
// Boundaries: a cross-app call is an off-chain request; revocation and the count are enforced by the called service only;
// before shells check it, the visitor compares the caller named in the grant with the site the wallet names.
import type { Address, Hex, TapeAPIError } from '@tapeapi/sdk'

/** @experimental The VisitorGrant message (14 members, in the order the wallet shows them; the statement first). */
export interface VisitorGrant {
  statement: string
  user: Address
  caller: Address
  callerName: string
  callerHolder: Address
  callerKey: Address
  audience: Address
  audienceName: string
  audienceHolder: Address
  methods: string[]
  maxCalls: number
  notBefore: number
  expires: number
  nonce: Hex
}
/** @experimental Revokes the listed grants of `user`, and every grant of `user` with notBefore below revokedBefore (0: none by date). */
export interface GrantRevocation { user: Address; grantHashes: Hex[]; revokedBefore: number; issued: number }
/** @experimental The EIP-712 domain: "TapeAPI Visitor Grant", "1", the called app's chain, that chain's DeWEB hub. */
export interface GrantDomain { name: 'TapeAPI Visitor Grant'; version: '1'; chainId: number; verifyingContract: Address }
/** @experimental One call proof: Unix seconds and the one-off key's EIP-191 signature. */
export interface CallProof { ts: number; sig: Hex }
/** @experimental The request's top-level member `grant`. */
export interface WireGrant { v: 1; chainId: number; message: VisitorGrant; userSig: Hex; proof: CallProof }
/** @experimental What a call proof binds. */
export interface CallProofInput { audience: Address; grantHash: Hex; id: string; method: string; params?: Record<string, unknown> | null; ts: number }
/** @experimental A typed-data result (wallet payload plus, for a grant, the page's display). */
export interface GrantTypedData {
  domain: GrantDomain
  types: Record<string, Array<{ name: string; type: string }>>
  primaryType: 'VisitorGrant' | 'GrantRevocation'
  message: Record<string, unknown>
  display?: { notice: string[]; notBefore: string; expires: string }
}
/** @experimental A refusal reason, in the order the service checks them. */
export type GrantReason = 'required' | 'malformed' | 'wrong-audience' | 'method-out-of-scope' | 'expired' | 'statement-mismatch' | 'bad-proof' | 'replayed' | 'bad-user-signature' | 'revoked' | 'audience-holder-changed' | 'audience-not-opened' | 'audience-unpaid' | 'caller-name-mismatch' | 'caller-holder-changed' | 'caller-not-opened' | 'caller-unpaid' | 'voucher-not-allowed' | 'rate-limited' | 'exhausted'
/** @experimental The record the service writes into `result.grant` (covered by its signature). */
export interface GrantRecord { hash: Hex; caller: Address; user: Address; used: number; maxCalls: number }
/** @experimental What the handler sees as ctx.grant. */
export interface GrantContext { hash: Hex; user: Address; caller: Address; callerName: string; callerKey: Address; methods: string[]; used: number; maxCalls: number; expires: number }
/** @experimental A reservation of one call. */
export interface GrantLease { used: number; commit(): void | Promise<void>; release(): void | Promise<void> }
/** @experimental Count, replay and revocation storage (memoryGrantStore is exact within one process only). */
export interface GrantStore {
  /** `expires`: the presented grant's expiry (a hash commits to it), so a store can drop the revocation after it. */
  isRevoked(user: Address, hash: Hex, notBefore: number, expires?: number): boolean | Promise<boolean>
  /** `expires`: the revoked grant's expiry when known (the check's caller-holder-changed); absent from grant_revoke. */
  revoke(user: Address, hashes: Hex[], expires?: number): void | Promise<void>
  revokeBefore(user: Address, t: number): void | Promise<void>
  delivered(hash: Hex, id: string): boolean | Promise<boolean>
  /** A call with this (hash, id) is in progress (refused `replayed` at step 8, before any chain read). */
  inFlight?(hash: Hex, id: string): boolean | Promise<boolean>
  /** null: exhausted; { replayed: true }: this (hash, id) is in flight or delivered */
  reserve(hash: Hex, id: string, maxCalls: number, expires: number): GrantLease | { replayed: true } | null | Promise<GrantLease | { replayed: true } | null>
  usedOf?(hash: Hex): number
  /** One call against the rate-limit window of `key` (grantMethods' perGrantWindow): 0 when it fits and is counted, else the seconds to wait. */
  take?(key: string, calls: number, windowS: number): number | Promise<number>
  /** Keep the envelope the provider signed for (hash, id) until `until` (Unix s), bound to `req` (the request's method and params), for a retry of the same id. */
  keepAnswer?(hash: Hex, id: string, env: Readonly<Record<string, unknown>>, o: { until: number; req: Hex }): unknown
  /** The kept envelope of (hash, id), or null. */
  answerOf?(hash: Hex, id: string): { env: Readonly<Record<string, unknown>>; req: Hex } | null | Promise<{ env: Readonly<Record<string, unknown>>; req: Hex } | null>
}
/** @experimental A TAP-10 site status (§6.2) of a name that resolved: anything but 'ok' is refused by the check, as the 2.0 default refuses it. */
export type GrantSiteStatus = 'ok' | 'not-opened' | 'unpaid'
/** @experimental The chain reads the check needs (a failure throws; never "no"). A reader that reports no `status` vouches for 'ok'. */
export interface GrantChainReads {
  holderOf(container: Address): Promise<Address | { holder: Address; status?: GrantSiteStatus }>
  resolveName(name: string): Promise<{ container: Address; holder: Address; status?: GrantSiteStatus } | null>
  isValidSignature?(address: Address, digest: Uint8Array, sig: Hex): Promise<boolean>
}
/** @experimental Options of the service side. */
export interface GrantServiceOptions {
  chainId: number; hub: Address; name: string; store: GrantStore; chain: GrantChainReads; clock?: () => number
  /** grantMethods: the deadline (ms) of a call with a grant, check and handler together; past it the call is released, answered INTERNAL and never counted. Keep it below the provider's handlerTimeoutMs. Default GRANT_HANDLER_TIMEOUT_MS (20 000). */
  timeoutMs?: number
  /** grantMethods: at most `calls` calls with a verified grant per `windowS` seconds (sliding) for one (caller, visitor), across their grants; one more is refused "rate-limited". Off by default (maxCalls already caps a grant). Needs store.take. */
  perGrantWindow?: { calls: number; windowS: number }
}
/** @experimental A signed grant as the calling app keeps it (the one-off key stays in its origin). */
export interface SignedGrant { chainId: number; hub: Address; message: VisitorGrant; userSig: Hex; callerKeyPk: Hex }
/** @experimental A service as resolved by the SDK (only what withGrant reads). */
export interface GrantService { container: Address; manifest: { endpoints: { live: string[] }; methods: Array<{ name: string; grant?: string }> } }
/** @experimental Inputs of makeGrant. */
export interface MakeGrantInput {
  user: Address; caller: Address; callerName: string; callerHolder: Address; callerKey: Address
  audience: Address; audienceName: string; audienceHolder: Address; methods: string[]; maxCalls: number
  notBefore?: number; expires?: number; lifeS?: number; nonce?: Hex; lang?: 'en' | 'zh'; now: number
}

/** @experimental */
export declare const GRANT_FORMAT_VERSION: 1
/** @experimental */
export declare const GRANT_DOMAIN_NAME: 'TapeAPI Visitor Grant'
/** @experimental */
export declare const GRANT_DOMAIN_VERSION: '1'
/** @experimental */
export declare const VISITOR_GRANT_TYPE: string
/** @experimental */
export declare const GRANT_REVOCATION_TYPE: string
/** @experimental */
export declare const VISITOR_GRANT_TYPEHASH: Uint8Array
/** @experimental */
export declare const GRANT_REVOCATION_TYPEHASH: Uint8Array
/** @experimental 8 */
export declare const MAX_GRANT_METHODS: number
/** @experimental 10,000 */
export declare const MAX_GRANT_CALLS: number
/** @experimental 7 days in seconds */
export declare const MAX_GRANT_LIFE_S: number
/** @experimental 1 hour in seconds */
export declare const DEFAULT_GRANT_LIFE_S: number
/** @experimental 300 s */
export declare const GRANT_SKEW_S: number
/** @experimental 24 */
export declare const MAX_REVOKED_GRANTS: number
/** @experimental 1024 */
export declare const MAX_USER_SIG_BYTES: number
/** @experimental */
export declare const METHOD_NAME_RE: RegExp
/** @experimental "TAPI-grant/call1" */
export declare const CALL_PROOF_PREFIX: string
/** @experimental 140 */
export declare const CALL_PROOF_PREIMAGE_BYTES: number
/** @experimental The v1 statement templates. */
export declare const STATEMENT_TEMPLATES: Readonly<Record<'en' | 'zh', (m: VisitorGrant) => string>>
/** @experimental */
export declare const STATEMENT_LANGS: readonly string[]
/** @experimental */
export declare const GRANT_WALLET_NOTICE: string
/** @experimental */
export declare const GRANT_WALLET_NOTICE_ZH: string
/** @experimental Shape check; `{ wire: true }` for a counterparty's message (exactly 14 members). Throws GRANT_INVALID. */
export declare function normalizeGrant(m: unknown, opts?: { wire?: boolean }): VisitorGrant
/** @experimental The statement of the other fields in 'en' or 'zh'. */
export declare function renderStatement(m: Omit<VisitorGrant, 'statement'> & { statement?: string }, lang?: 'en' | 'zh'): string
/** @experimental Is m.statement exactly a v1 rendering? */
export declare function statementMatches(m: VisitorGrant): boolean
/** @experimental */
export declare function grantDomain(chainId: number, hub: Address): GrantDomain
/** @experimental */
export declare function grantDomainSeparator(chainId: number, hub: Address): Hex
/** @experimental EIP-712 hashStruct(VisitorGrant). */
export declare function hashVisitorGrant(m: VisitorGrant): Uint8Array
/** @experimental The digest the wallet signs (the grant's identity). */
export declare function grantDigest(chainId: number, hub: Address, m: VisitorGrant): Uint8Array
/** @experimental grantHash, 0x hex. */
export declare function grantHashOf(chainId: number, hub: Address, m: VisitorGrant): Hex
/** @experimental Build the message with its statement (defaults: now, 1 h, random nonce, en). */
export declare function makeGrant(o: MakeGrantInput): VisitorGrant
/** @experimental eth_signTypedData_v4 payload plus `display`; refuses a statement that is not generated. */
export declare function grantTypedData(chainId: number, hub: Address, m: VisitorGrant): GrantTypedData
/** @experimental Rebuild and compare; `expect` names the chain, hub and (for a grant) the two names the page resolved. */
export declare function grantForWallet(td: GrantTypedData, expect: { chainId: number; hub: Address; callerName?: string; audienceName?: string }): { payload: Omit<GrantTypedData, 'display'>; display?: GrantTypedData['display'] }
/** @experimental Local-key signing (tests, scripts). */
export declare function signGrant(chainId: number, hub: Address, m: VisitorGrant, pk: Hex): Hex
/** @experimental */
export declare function normalizeGrantRevocation(r: unknown): GrantRevocation
/** @experimental */
export declare function hashGrantRevocation(r: GrantRevocation): Uint8Array
/** @experimental */
export declare function grantRevocationDigest(chainId: number, hub: Address, r: GrantRevocation): Uint8Array
/** @experimental */
export declare function grantRevocationTypedData(chainId: number, hub: Address, r: GrantRevocation): GrantTypedData
/** @experimental Local-key signing (tests, scripts). */
export declare function signGrantRevocation(chainId: number, hub: Address, r: GrantRevocation, pk: Hex): Hex
/** @experimental The 140-byte preimage. */
export declare function callProofPreimage(o: CallProofInput): Uint8Array
/** @experimental keccak256 of the preimage. */
export declare function callProofDigest(o: CallProofInput): Uint8Array
/** @experimental Sign one request with the one-off key. */
export declare function signCallProof(o: CallProofInput, callerKeyPk: Hex): CallProof
/** @experimental The key that signed a call proof, or null. */
export declare function recoverCallProofSigner(o: CallProofInput, sig: string): Address | null
/** @experimental The request's top-level member. */
export declare function wireGrant(o: { chainId: number; message: VisitorGrant; userSig: Hex; proof: CallProof }): WireGrant
/** @experimental */
export declare const GRANT_REASONS: readonly GrantReason[]
/** @experimental "grant_revoke" */
export declare const GRANT_REVOKE_METHOD: string
/** @experimental "grant" */
export declare const GRANT_RESULT_MEMBER: string
/** @experimental How long after its ts a signed answer is kept for a retry of the same id (300 s: a client refuses an older ts). */
export declare const GRANT_ANSWER_KEEP_S: number
/** @experimental grantMethods' default deadline for a call with a grant (20 000 ms), below @tapeapi/server's default handlerTimeoutMs. */
export declare const GRANT_HANDLER_TIMEOUT_MS: number
/** @experimental BAD_REQUEST with the message "grant: <reason>" and no data. */
export declare function grantRefusal(reason: GrantReason, detail?: string): TapeAPIError
/** @experimental The reason of a signed refusal, or null. */
export declare function grantReasonOf(e: unknown): GrantReason | null
/** @experimental Manifest checks for methods that take grants (free; "required" | "optional"). */
export declare function grantManifestProblems(manifest: { methods?: Array<{ name: string; priceBEM?: string; grant?: unknown }> }, o?: { methods?: Record<string, unknown> | null }): string[]
/** @experimental In-memory store, exact within one process. */
/** @experimental In memory, one process: revocations, counts and replay records are lost on restart (persist revoke and revokeBefore in production). Revocations are bounded by maxRevocations (default 100 000) and dropped once their grant has expired; a full store refuses a new one (INTERNAL). Signed answers kept for a retry of the same id are bounded by maxAnswers (default 1 000; 0 keeps none) and maxAnswerBytes (default 16 MiB), oldest dropped first. */
export declare function memoryGrantStore(o?: { clock?: () => number; maxRevocations?: number; maxUnseenRevocations?: number; maxRateKeys?: number; maxAnswers?: number; maxAnswerBytes?: number }): Omit<GrantStore, 'take' | 'keepAnswer' | 'answerOf'> & { usedOf(hash: Hex): number; revocations(): { byHash: number; before: number; unseen: number }; inFlight(hash: Hex, id: string): boolean; take(key: string, calls: number, windowS: number): number; rateKeys(): number; keepAnswer(hash: Hex, id: string, env: Readonly<Record<string, unknown>>, o: { until: number; req: Hex }): boolean; answerOf(hash: Hex, id: string): { env: Readonly<Record<string, unknown>>; req: Hex } | null; answers(): { count: number; bytes: number } }
/** @experimental The chain reads from an SDK client: api.siteStatus, identity and TAP-10 site status at one pinned block, as the 2.0 default resolution reads them; cached <= cacheS. */
export declare function chainReadsFromApi(api: unknown, o?: { rpc?: unknown; chainId?: number; clock?: () => number; cacheS?: number; maxCacheEntries?: number }): {
  holderOf(container: Address): Promise<{ holder: Address; status: GrantSiteStatus }>
  resolveName(name: string): Promise<{ container: Address; holder: Address; status: GrantSiteStatus } | null>
  isValidSignature(address: Address, digest: Uint8Array, sig: Hex): Promise<boolean>
}
/** @experimental The called service's check (steps 1-13; cheap checks first: names and holders are read only after the visitor's signature). Chain-read failures throw. */
export declare function verifyVisitorGrant(wire: unknown, o: {
  chainId: number; hub: Address; me: { container: Address; name: string }; manifest: { methods?: Array<{ name: string; grant?: string }> }
  method: string; id: string; params: Record<string, unknown>; voucherSent: boolean; now: number; store: GrantStore; chain: GrantChainReads
  window?: { calls: number; windowS: number } | null
}): Promise<{ ok: false; reason: GrantReason; detail?: string; resend?: Readonly<Record<string, unknown>> } | { ok: true; hash: Hex; message: VisitorGrant; lease: GrantLease; record: GrantContext }>
/** @experimental Wrap a provider's handlers: check the grant, give ctx.grant, write result.grant. Needs ctx.request from @tapeapi/server. */
export declare function grantMethods<M extends Record<string, (params: any, ctx: any) => unknown>>(methods: M, o: GrantServiceOptions): { [K in keyof M]: (params: any, ctx: any) => Promise<unknown> }
/** @experimental The free method grant_revoke. */
export declare function grantRevokeHandler(o: GrantServiceOptions): (params: { revocation: GrantRevocation; sig: Hex }) => Promise<{ revoked: GrantRevocation & { hash: Hex } }>
/** @experimental Build a grant with every identity read from the chain. */
export declare function prepareGrant(o: Omit<MakeGrantInput, 'caller' | 'callerHolder' | 'audienceHolder'> & { chain: GrantChainReads }): Promise<VisitorGrant>
/** @experimental Check the record in a verified result; throws GRANT_NOT_HONOURED. */
export declare function checkGrantRecord(result: unknown, expect: { hash: Hex; caller: Address; user: Address; maxCalls: number }): { hash: Hex; used: number; maxCalls: number }
/** @experimental The calling app's decorated fetch and call. */
export declare function withGrant(fetch?: typeof globalThis.fetch, o?: { clock?: () => number }): {
  fetch: typeof globalThis.fetch
  attach(id: string, svc: GrantService, grant: SignedGrant): void
  detach(id: string): void
  call<R = any>(api: { call(svc: any, method: string, params?: Record<string, unknown>, opts?: Record<string, unknown>): Promise<{ result: R; verified: true; ts: number; id: string; sig: Hex }> }, svc: GrantService, method: string, params: Record<string, unknown>, grant: SignedGrant, opts?: Record<string, unknown>): Promise<{ result: R; verified: true; ts: number; id: string; sig: Hex; grant: { hash: Hex; used: number; maxCalls: number } }>
}
