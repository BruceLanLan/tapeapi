import type { Hex, Address, BigNumberish } from './common.js'

export declare function privateKeyToAddress(pk: string | Uint8Array): Address
export declare function randomPrivateKey(): Hex
export declare function personalDigest(digest: Uint8Array | string): Uint8Array
export declare function signDigest(digest: Uint8Array | string, pk: string | Uint8Array): Hex
export declare function parseSignature(sig: string | Uint8Array): { r: Uint8Array; s: Uint8Array; v: number }
export declare function recoverAddress(digest: Uint8Array | string, sig: string | Uint8Array): Address

export declare const DELEGATION_TYPE: string
/** @experimental Not covered by the 1.0 stability promise (TAP-22 payments / ServiceDirectory are not deployed); may change in a 1.x minor release. */
export declare const VOUCHER_TYPE: string
export declare const DELEGATION_TYPEHASH: Uint8Array
/** @experimental Not covered by the 1.0 stability promise (TAP-22 payments / ServiceDirectory are not deployed); may change in a 1.x minor release. */
export declare const VOUCHER_TYPEHASH: Uint8Array
export declare const CHANNEL_KEYS_TYPE: string
export declare const CHANNEL_KEYS_TYPEHASH: Uint8Array
export declare const RESPONSE_DIGEST_PREFIX: string

export interface Delegation { container: Address; signer: Address; expires: BigNumberish }
/** @experimental Not covered by the 1.0 stability promise (TAP-22 payments / ServiceDirectory are not deployed); may change in a 1.x minor release. */
export interface Voucher { consumer: Address; provider: Address; cumulative: BigNumberish; expires: BigNumberish }
export interface EIP712Domain { name: string; version: string; chainId: number; verifyingContract: Address }
/** EIP-712 typed data as passed to eth_signTypedData_v4. */
export interface TypedData { domain: EIP712Domain; types: Record<string, unknown>; primaryType: string; message: Record<string, unknown> }

export declare function channelInboxHash(inbox?: Record<string, unknown>): Uint8Array
export declare function domainSeparator(domain: EIP712Domain): Uint8Array
export declare function hashDelegation(d: Delegation): Uint8Array
/** @experimental Not covered by the 1.0 stability promise (TAP-22 payments / ServiceDirectory are not deployed); may change in a 1.x minor release. */
export declare function hashVoucher(v: Voucher): Uint8Array
export declare function hashChannelKeys(k: Record<string, unknown>): Uint8Array
export declare function typedDigest(domain: EIP712Domain, structHash: Uint8Array): Uint8Array
export declare function delegationDomain(chainId: number, hub: Address): EIP712Domain
/** @experimental Not covered by the 1.0 stability promise (TAP-22 payments / ServiceDirectory are not deployed); may change in a 1.x minor release. */
export declare function voucherDomain(chainId: number, escrow: Address): EIP712Domain
export declare function delegationDigest(chainId: number, hub: Address, d: Delegation): Uint8Array
/** @experimental Not covered by the 1.0 stability promise (TAP-22 payments / ServiceDirectory are not deployed); may change in a 1.x minor release. */
export declare function voucherDigest(chainId: number, escrow: Address, v: Voucher): Uint8Array
export declare function channelKeysDigest(chainId: number, hub: Address, k: Record<string, unknown>): Uint8Array
export declare function channelKeysTypedData(chainId: number, hub: Address, k: Record<string, unknown>): TypedData
export declare function delegationTypedData(chainId: number, hub: Address, d: Delegation): TypedData
/** @experimental Not covered by the 1.0 stability promise (TAP-22 payments / ServiceDirectory are not deployed); may change in a 1.x minor release. */
export declare function voucherTypedData(chainId: number, escrow: Address, v: Voucher): TypedData
/** TAP-21 v2 response digest over { container, id, method, params, ok, body, ts }. */
export declare function responseDigest(env: Record<string, unknown>): Uint8Array
export declare function signResponse(env: Record<string, unknown>, pk: string): Hex
export declare function recoverResponseSigner(env: Record<string, unknown>, sig: string): Address
/** keccak256(canonicalJSON({ method, params })) as 0x hex: the request hash inside the TAP-21 digest. */
export declare function responseRequestHash(req: { method: string; params?: unknown }): string
/** keccak256(canonicalJSON(body)) as 0x hex: the result (or error) hash inside the TAP-21 digest. */
export declare function responseBodyHash(body: unknown): string
/** The TAP-21 digest rebuilt from the two inner hashes (a hash-only receipt); the same 32 bytes as responseDigest. */
export declare function responseDigestFromHashes(env: { container: string; id: string; requestHash: string; ok: boolean; bodyHash: string; ts: number }): Uint8Array
export declare function recoverResponseSignerFromHashes(env: { container: string; id: string; requestHash: string; ok: boolean; bodyHash: string; ts: number }, sig: string): Address

/** @experimental (security 1.1, TAP-20 §3.10) The OPTIONAL manifest field that carries the holder's content signature. */
export declare const MANIFEST_CONTENT_FIELD: 'contentSig'
/** @experimental (security 1.1) 'ManifestContent(address container,bytes32 contentHash)' */
export declare const MANIFEST_CONTENT_TYPE: string
/** @experimental (security 1.1) */
export declare const MANIFEST_CONTENT_TYPEHASH: Uint8Array
/** @experimental (security 1.1) keccak256(UTF-8(canonicalJSON(manifest without its top-level contentSig))). */
export declare function manifestContentHash(manifest: Record<string, unknown>): Uint8Array
/** @experimental (security 1.1) */
export declare function hashManifestContent(c: { container: Address; contentHash: Uint8Array | string }): Uint8Array
/** @experimental (security 1.1) The digest the holder signs, in the TAP-20 delegation domain. */
export declare function manifestContentDigest(chainId: number, hub: Address, c: { container: Address; contentHash: Uint8Array | string }): Uint8Array
/** @experimental (security 1.1) Typed data for eth_signTypedData_v4; `manifest` is the manifest to publish, without contentSig. */
export declare function manifestContentTypedData(chainId: number, hub: Address, c: { container: Address; manifest: Record<string, unknown> }): TypedData
