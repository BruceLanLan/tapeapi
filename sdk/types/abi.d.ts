import type { Hex, Address } from './common.js'

export declare function strip0x(h: string): string
export declare function hexToBytes(h: string): Uint8Array
export declare function toHex(bytes: Uint8Array): Hex
export declare function bytesToHex(bytes: Uint8Array): string
export declare function concatBytes(...arrays: Uint8Array[]): Uint8Array
export declare function utf8ToBytes(str: string): Uint8Array
export declare function keccak256(data: Uint8Array | string): Uint8Array
export declare function isAddress(a: unknown): a is Address
export declare function checksumAddress(a: string): Address
export declare function eqAddr(a: unknown, b: unknown): boolean
export declare const ZERO_ADDRESS: Address
export declare const LABEL_RE: RegExp
export declare function labelToBytes32(label: string): Hex
export declare function bytes32ToLabel(h: string): string
export declare function encodeParams(types: string[], values: unknown[]): Hex
export declare function decodeParams(types: string[], data: string | Uint8Array, base?: number): any[]
/** @internal The ServiceDirectory record layout (experimental contract); not part of the 1.0 API. */
export declare const SERVICE_TUPLE: Record<string, unknown>
/**
 * @internal The ABI table encodeCall / decodeReturn look names up in. Its entries follow the contracts, including the
 * experimental escrow and ServiceDirectory, and may change in any release; only the names of the stable contracts
 * (hub, SiteRegistry, processor factory, ChannelBus, ERC-20/721, ERC-6551) are part of the 1.0 API.
 */
export declare const FUNCTIONS: Record<string, { inputs: unknown[]; outputs: unknown[]; [key: string]: unknown }>
export declare function signatureOf(name: string): string
export declare function selector(nameOrSig: string): Hex
export declare function encodeCall(name: string, args?: unknown[]): Hex
export declare function decodeCall(name: string, data: string): any
export declare function decodeReturn(name: string, data: string): any
export declare function encodeReturn(name: string, values: unknown): Hex
export declare function functionBySelector(data: string): any
