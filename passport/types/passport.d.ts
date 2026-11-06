// @tapeapi/passport (@experimental): types. Everything here follows an OPEN draft (TapeOutProtocol/TAPs pull request
// #83 at head cae25e6, not merged) and is outside any compatibility promise: it may change or go away in any release.
// 类型。全部依据未合并的草案（TAPs PR #83，头 cae25e6），不受任何兼容承诺约束，任何版本都可能改动或移除。

/** A createRpc() client of @tapeapi/sdk/rpc (structural: what this package calls). / SDK createRpc() 客户端（结构类型）。 */
export interface PassportRpc {
  tap10Block(opts: { maxLag: number }): Promise<{ number: number; hash: string; timestamp: number; heads?: Record<string, number> }>
  call(method: string, params?: unknown[], opts?: { answers?: 'tap10'; strict?: boolean; project?: (answer: any, i: number) => unknown }): Promise<any>
  ethCall(to: string, data: string, block?: unknown, opts?: { answers?: 'tap10'; strict?: boolean }): Promise<string>
}
/** A createTapeAPI() client of chain 56 (structural): its nodes and, when it has it, the processor table. */
export interface PassportApi {
  chainId: number
  rpc: PassportRpc | null
  addresses?: { factory?: string }
  chain?: { processorNumber?: (processor: string, opts?: { at?: { number: number; hash: string } }) => Promise<string | null> }
  forChain?: (chainId: number) => PassportApi
}

/** The draft this version follows; every result carries it. / 本版本依据的草案；每个结果都带着它。 */
export declare const DRAFT: Readonly<{
  repo: 'TapeOutProtocol/TAPs'; pr: 83; head: 'cae25e6df54ad2e2e38e185304de55f92792966d'; merged: false
  vectorsSha256: '7720772c05d60062f48daa7c1d2ab6f45affc3d05425126d9de9b00a4ff8fca4'
  mcpDraft: Readonly<{ pr: 16; head: '13d1179f89b8c7037ebfb4e3ec3e574c1740e989' }>
  reviewsDraft: Readonly<{ pr: 54; head: '703b2a91edf7545b3179a08b8041b49190fd4a0a'; merged: false }>
  status: 'experimental'
}>

export interface PassportConfig {
  chainId: number
  identityRegistry: string; identityImplementations: readonly string[]
  reputationRegistry: string; reputationImplementations: readonly string[]
  factory: string; opener: string; siteRegistry: string; siteRegistryImplementations: readonly string[]
}
/** The registries and TapeOut contracts of BNB Smart Chain the draft reads (§2). The registries are upgradeable (UUPS). */
export declare const PASSPORT_CONFIG: Readonly<PassportConfig>
export declare const SNAPSHOT_FORMAT: 'tap-agent-passport-snapshot/1'
export declare const PASSPORT_KEY: 'tap.passport'
export declare const REGISTRATION_KEY: '.well-known/agent-registration.json'
export declare const MANIFEST_KEY: '.well-known/tapeapi.json'
export declare const REGISTRATION_TYPE: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1'
export declare const MAX_REGISTRATION_BYTES: 65536

export type PassportState = 'CONFIRMED' | 'BROKEN' | 'AMBIGUOUS' | 'wallet-unset' | 'stale-agent-wallet' | 'UNAVAILABLE'
/** §6.3's reasons. An open set: the draft only ever adds names, so an unknown string is shown as it is. */
export type PassportReason =
  | 'wrong-chain' | 'stale-block' | 'node-disagreement' | 'unavailable' | 'registry-changed' | 'store-changed'
  | 'no-such-agent' | 'holder-mismatch' | 'no-passport-key' | 'bad-passport-key' | 'chain-mismatch' | 'not-tapeout' | 'no-such-token' | 'not-opened'
  | 'registration-file-missing' | 'registration-file-too-large' | 'registration-file-incomplete' | 'registration-file-no-hash' | 'registration-file-invalid'
  | 'forbidden-name' | 'file-chain-mismatch' | 'tape-service-missing' | 'stale-operator' | 'wallet-unset' | 'stale-agent-wallet' | 'not-listed'
  | 'several-listed' | 'key-circuit-mismatch' | (string & {})
export type PassportWarning = 'operators-not-checked' | 'agent-uri-not-canonical' | 'manifest-hash-differs' | 'holder-changed' | 'transfer-history-unavailable' | (string & {})
export declare const STATES: readonly PassportState[]
export declare const REASONS: Readonly<Record<string, string>>
export declare const WARNINGS: readonly PassportWarning[]

export interface Bilingual { en: string; zh: string }
export interface HolderEpoch { startBlock: number; changed: boolean; identityRegisteredBlock: number }
export interface PassportResult {
  state: PassportState
  /** Exactly one reason, [] for CONFIRMED. / 恰好一个原因；CONFIRMED 为空。 */
  reasons: PassportReason[]
  warnings: PassportWarning[]
  /** Every listed identity for AMBIGUOUS (D-3: none is picked). / AMBIGUOUS 时为列出的全部身份。 */
  agentId: string | string[] | null
  holder: string | null; processor: string | null; tokenId: string | null; container: string | null
  /** The on-chain name, 4246.0.tape. / 链上名。 */
  name: string | null
  pinnedBlock: number | null; blockHash: string | null
  /** null: unknown (the history was not obtained). / null 表示未知。 */
  holderEpoch: HolderEpoch | null
  /** What was not checked, said explicitly; logs: whether log nodes were configured (live only). */
  checked: { siteOperators: boolean; holderHistory: boolean; logs?: boolean }
  /** D-1 to D-6; `en` is the draft's sentence exactly. / en 与草案原句一致。 */
  display: Bilingual
  detail?: string; unavailableRead?: string; agentUri?: string | null
  reads?: number
  snapshot?: PassportSnapshot
  draft: typeof DRAFT
  experimental: true
}
export interface PassportSnapshot {
  format: 'tap-agent-passport-snapshot/1'
  config: PassportConfig
  input: PassportInput
  pinnedBlock: number
  answers?: Record<string, unknown>
  operators: Record<string, { head: number; answers?: Record<string, unknown> }>
  processorNumbers?: Record<string, number>
  [k: string]: unknown
}
export type PassportInput = { agentId: string | bigint | number } | { circuit: { processor: string; tokenId: string | bigint | number } } | { name: string }

/** The reads of one resolution (snapshot replay or live). / 一次解析的读取。 */
export interface PassportReads {
  pinnedBlock: number | null
  heads: number[]
  get(key: string): Promise<any>
  processorNumber?: (processor: string) => Promise<number | null>
  maxProcessorScan?: number
  used?: string[]
}
export interface LogsOption {
  urls?: string[]; rpc?: PassportRpc
  /** Default 0 (sound, but far over the default budget on BNB Smart Chain). / 默认 0。 */
  fromBlock?: number | { operators?: number; identity?: number; circuit?: number }
  chunk?: number; maxRequests?: number
}
export interface ResolvePassportOptions {
  api?: PassportApi
  rpc?: PassportRpc
  rpcUrls?: string[]
  /** Log-capable nodes for P-8 and §7; without them both are warnings, never a pass. Default 'off'. */
  logs?: 'off' | LogsOption
  maxProcessorScan?: number
  recordSnapshot?: boolean
  config?: PassportConfig
  fetch?: typeof fetch
}
/** Resolve a passport read-only at one pinned block under strict agreement; throws only INVALID_ARGUMENT. */
export declare function resolvePassport(input: PassportInput, opts?: ResolvePassportOptions): Promise<PassportResult>
/** Replay a snapshot offline (the draft's vectors, or recordSnapshot). / 离线回放快照。 */
export declare function resolveFromSnapshot(snapshot: PassportSnapshot): Promise<PassportResult>
export declare function snapshotReads(snapshot: PassportSnapshot): PassportReads
export declare function liveReads(rpc: PassportRpc, opts?: { config?: PassportConfig; logs?: ReturnType<typeof logsClient>; processorNumber?: (processor: string, pin: { number: number; hash: string }) => Promise<number | null>; maxProcessorScan?: number }): Promise<PassportReads & { answers: Record<string, unknown> }>
export declare function logsClient(logs: 'off' | LogsOption | null | undefined, opts?: { fetch?: typeof fetch }): { rpc: PassportRpc; fromBlock?: LogsOption['fromBlock']; chunk?: number; maxRequests?: number } | null
export declare function snapshotOf(reads: PassportReads, input: PassportInput, config?: PassportConfig): PassportSnapshot
export declare function callOfKey(key: string): { to: string; data: string } | null
export declare const LOG_TOPICS: Readonly<{ Transfer: string; OperatorSet: string }>
export declare const LOG_DEFAULTS: Readonly<{ chunk: number; maxRequests: number; fromBlock: number }>
export declare const MAX_PROCESSOR_SCAN: number

/** §4: abi.encode(uint256 chainId, address processor, uint256 tokenId), 96 bytes. */
export declare function encodePassportKey(chainId: number | bigint, processor: string, tokenId: bigint | number | string): Uint8Array
/** §4: throws INVALID_ARGUMENT with data.reason no-passport-key | bad-passport-key. */
export declare function decodePassportKey(bytes: Uint8Array): { chainId: number; processor: string; tokenId: bigint }

/** §5.4 with the draft's confusable table (31 letters and their capitals); it does not catch every look-alike. */
export declare function forbiddenName(name: string): boolean
export declare function normaliseName(name: string): { joined: string; segs: string[] }
export declare const CONFUSABLES: Readonly<Record<string, string>>
/** Strict JSON keeping 56 (number) and 56.0 (JFloat) apart; SyntaxError, TypeError (UTF-8) or NoCanonicalForm. */
export declare function strictJson(bytes: Uint8Array): unknown
export declare function canonicalJson(value: unknown): string
export declare class JFloat { constructor(v: number); v: number }
export declare class NoCanonicalForm extends Error {}

export interface RegistrationFileInput {
  agentId: bigint | number | string; processor: string; tokenId: bigint | number | string; container: string
  /** The on-chain name, 4246.0.tape. / 链上名。 */
  name: string
  manifestSha256?: string; displayName?: string; description?: string; image?: string; extraServices?: object[]; gatewayDomain?: string
}
export interface RegistrationFileCheck { ok: boolean; reason?: string; detail?: string }
export declare function buildRegistrationFile(p: RegistrationFileInput): { bytes: Uint8Array; text: string; agentUri: string | null; key: '.well-known/agent-registration.json'; problems: RegistrationFileCheck[] }
export declare function checkRegistrationFile(bytes: Uint8Array, expect?: { agentId?: bigint | number | string; processor?: string; tokenId?: bigint | number | string; container?: string; name?: string }): RegistrationFileCheck
export declare function canonicalAgentUri(tokenId: bigint | number | string, processorNumber: number, gatewayDomain: string): string
export interface PassportRegistrationPlan {
  status: 'ready' | 'fail' | 'unavailable'
  checks: { id: string; ok: boolean; reason?: string; detail: Bilingual }[]
  pinnedBlock: number | null; agentId: string; reason?: string
  holder?: string; container?: string; name?: string; processor?: string; tokenId?: string
  file?: ReturnType<typeof buildRegistrationFile>; agentUri?: string | null; agentUriForm?: string; steps?: Bilingual[]
}
/** tapeapi init --passport: read-only checks, then the file from chain reads. It never sends or writes anything. */
export declare function preparePassportRegistration(o: { api?: PassportApi; rpc?: PassportRpc; agentId: string | bigint | number; name?: string; circuit?: { processor: string; tokenId: string | bigint | number }; gatewayDomain?: string; displayName?: string; description?: string; logs?: 'off' | LogsOption; config?: PassportConfig }): Promise<PassportRegistrationPlan>
export declare function registrationSteps(name: string): Bilingual[]

/** Appendix B: an A2A 1.0 card for a CONFIRMED passport only, display only, never a source of signers (S-2). */
export declare function agentCardFromPassport(p: { result: PassportResult; manifest: Record<string, any>; manifestSha256: string; registrationFile?: Record<string, any>; a2aEndpoints: string[]; tools?: unknown }): { card: Record<string, unknown> | null; why?: string; notes: Bilingual[] }

/** W-3. / 受不可信文字驱动的运行时。 */
export declare function checkRuntimeCall(cfg: PassportConfig & { knownProcessors?: string[] }, to: string, data: string, fromCounterpartyText?: boolean): { allowed: boolean; why: string }
/** W-1 / W-2. Since 3.0 the holder console that the SDK's `tapeapi init` points to proposes 30 days (1 to 366 by choice; see the guide). */
export declare function checkDelegationProposal(now: number, expires: number, isDefault: boolean, signerGeneratedHere: boolean): { ok: boolean; why: string }

export declare const DISPLAY_FORBIDDEN: readonly string[]
export declare const PASSPORT_NOTES: Readonly<{ experimental: Bilingual; receipt: Bilingual; holderText: Bilingual }>
export declare function displayOf(result: Pick<PassportResult, 'state' | 'reasons' | 'warnings' | 'name' | 'container' | 'agentId' | 'pinnedBlock' | 'holderEpoch'>): Bilingual
export declare function holderText(text: unknown, max?: number): string | null
export declare function reasonZh(reason: string): string
