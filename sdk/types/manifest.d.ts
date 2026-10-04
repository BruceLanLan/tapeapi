/** A TAPI-20 manifest method descriptor. Loose on purpose: see spec/TAPI-20. */
export interface ManifestMethod {
  name: string
  priceBEM?: string
  description?: string
  params?: Record<string, unknown>
  returns?: unknown
  attestedRead?: unknown
  [key: string]: unknown
}

/** A TAPI-20 service manifest (`/.well-known/tapeapi.json`). Loose on purpose: see spec/TAPI-20. */
export interface Manifest {
  container: string
  circuits: string
  tokenId: string | number
  signer: string
  name?: string
  endpoints: { live: string[]; [key: string]: unknown }
  methods: ManifestMethod[]
  payment?: { escrow?: string; [key: string]: unknown }
  delegation?: Record<string, unknown>
  [key: string]: unknown
}

export declare const METHOD_NAME_RE: RegExp
export declare const MAX_NAME_LEN: number
export declare const MAX_DELEGATION_S: number
export declare const BEM_DECIMALS: number
/** Decimal string -> base units (default 8 decimals, BEM). */
export declare function parseUnits(str: string, decimals?: number): bigint
/** Base units -> decimal string (default 8 decimals, BEM). */
export declare function formatUnits(wei: bigint | number | string, decimals?: number): string
/** Validates a manifest and returns it normalised; throws TapeAPIError('MANIFEST_INVALID'). */
export declare function validateManifest(m: unknown, opts?: { requireDelegation?: boolean; allowHttp?: boolean; now?: number }): Manifest
export declare function findMethod(manifest: Manifest, name: string): ManifestMethod | null
export declare function methodPrice(method: ManifestMethod): bigint

/** @experimental (1.7) The optional `agent` member of a manifest (container agents; Idea TapeOutProtocol/TAPs#41). */
export interface AgentMember {
  capabilities: string[]
  tasks: Array<{
    kind: string
    /** the FORMAT of a price: free, fixed (token, amount in the smallest unit, unit) or by quote; never a price list of ours */
    pricing: { mode: 'free' | 'fixed' | 'quote'; token?: string; amount?: string; unit?: string }
    maxDurationS?: number
    description?: string
  }>
  mandates: { accepts: boolean; enforcement?: string[] }
  /** "sha256:" and 64 hex digits: the SHA-256 of the terms text the agent publishes */
  terms?: string
}
/** @experimental (1.7) */
export declare const AGENT_PRICING_MODES: readonly ['free', 'fixed', 'quote']
/** @experimental (1.7) */
export declare const AGENT_MAX_TASKS: number
/** @experimental (1.7) */
export declare const AGENT_MAX_CAPABILITIES: number
/** @experimental (1.7) Validates `manifest.agent` and returns a copy without unknown members; throws MANIFEST_INVALID.
 *  validateManifest never calls it: a manifest's validity does not depend on this member. */
export declare function validateAgentMember(agent: unknown): AgentMember
