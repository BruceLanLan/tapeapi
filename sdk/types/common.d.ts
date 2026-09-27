// Shared shapes for @tapeapi/sdk declarations (not a public subpath).

/** 0x-prefixed hex string (addresses, calldata, hashes, signatures). */
export type Hex = string
/** 0x-prefixed 20-byte address (any case accepted; the SDK returns checksummed addresses). */
export type Address = string
export type BigNumberish = bigint | number | string

/** A transaction the SDK builds but never sends: pass it to your own wallet. */
export interface TxRequest {
  to: Address
  data: Hex
  value: Hex
  gas?: Hex
}

/** A `fetch`-compatible function. */
export type FetchLike = (input: any, init?: any) => Promise<any>
