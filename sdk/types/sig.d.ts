import type { Hex, Address, BigNumberish } from './common.js'

export declare function keccak256(data: Uint8Array | string): Uint8Array
export declare function privateKeyToAddress(pk: string | Uint8Array): Address
export declare function randomPrivateKey(): Hex
export declare function personalDigest(digest: Uint8Array | string): Uint8Array
export declare function signDigest(digest: Uint8Array | string, pk: string | Uint8Array): Hex
export declare function parseSignature(sig: string | Uint8Array): { r: Uint8Array; s: Uint8Array; v: number }
export declare function recoverAddress(digest: Uint8Array | string, sig: string | Uint8Array): Address

export declare const DELEGATION_TYPE: string
export declare const VOUCHER_TYPE: string
export declare const DELEGATION_TYPEHASH: Uint8Array
export declare const VOUCHER_TYPEHASH: Uint8Array
export declare const CHANNEL_KEYS_TYPE: string
export declare const CHANNEL_KEYS_TYPEHASH: Uint8Array
export declare const RESPONSE_DIGEST_PREFIX: string

export interface Delegation { container: Address; signer: Address; expires: BigNumberish }
export interface Voucher { consumer: Address; provider: Address; cumulative: BigNumberish; expires: BigNumberish }
export interface EIP712Domain { name: string; version: string; chainId: number; verifyingContract: Address }
/** EIP-712 typed data as passed to eth_signTypedData_v4. */
export interface TypedData { domain: EIP712Domain; types: Record<string, unknown>; primaryType: string; message: Record<string, unknown> }

export declare function channelInboxHash(inbox?: Record<string, unknown>): Uint8Array
export declare function domainSeparator(domain: EIP712Domain): Uint8Array
export declare function hashDelegation(d: Delegation): Uint8Array
export declare function hashVoucher(v: Voucher): Uint8Array
export declare function hashChannelKeys(k: Record<string, unknown>): Uint8Array
export declare function typedDigest(domain: EIP712Domain, structHash: Uint8Array): Uint8Array
export declare function delegationDomain(chainId: number, hub: Address): EIP712Domain
export declare function voucherDomain(chainId: number, escrow: Address): EIP712Domain
export declare function delegationDigest(chainId: number, hub: Address, d: Delegation): Uint8Array
export declare function voucherDigest(chainId: number, escrow: Address, v: Voucher): Uint8Array
export declare function channelKeysDigest(chainId: number, hub: Address, k: Record<string, unknown>): Uint8Array
export declare function channelKeysTypedData(chainId: number, hub: Address, k: Record<string, unknown>): TypedData
export declare function delegationTypedData(chainId: number, hub: Address, d: Delegation): TypedData
export declare function voucherTypedData(chainId: number, escrow: Address, v: Voucher): TypedData
/** TAP-21 v2 response digest over { container, id, method, params, ok, body, ts }. */
export declare function responseDigest(env: Record<string, unknown>): Uint8Array
export declare function signResponse(env: Record<string, unknown>, pk: string): Hex
export declare function recoverResponseSigner(env: Record<string, unknown>, sig: string): Address
export declare function bytesToHex(bytes: Uint8Array): string
export declare function toHex(bytes: Uint8Array): Hex
export declare function hexToBytes(h: string): Uint8Array
