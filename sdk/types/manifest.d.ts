/** A TAP-20 manifest method descriptor. Loose on purpose: see spec/TAP-20. */
export interface ManifestMethod {
  name: string
  priceBEM?: string
  description?: string
  params?: Record<string, unknown>
  returns?: unknown
  attestedRead?: unknown
  [key: string]: unknown
}

/** A TAP-20 service manifest (`/.well-known/tapeapi.json`). Loose on purpose: see spec/TAP-20. */
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
