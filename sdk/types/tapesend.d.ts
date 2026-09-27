// TAP-10 sealed messages, byte-compatible with @tapekit/send. Loose shapes: see spec/TAP-10.
import type { Address, TxRequest, BigNumberish } from './common.js'

export declare const MAGIC: Uint8Array
export declare const FORMAT_VERSION: number
export declare const KIND_PUBLIC: number
export declare const KIND_SEALED: number
export declare const MAX_PAYLOAD: number
export declare const MAX_SLOTS: number
export declare const SEND_SELECTOR: string

export declare function endpoint(target: Address | Record<string, unknown>, chainId?: number): Uint8Array
export declare function fingerprint(publicKey: Uint8Array): Uint8Array
export declare function assertValidPublicKey(publicKey: Uint8Array): void
export declare function encodePublic(content: Uint8Array): Uint8Array
export declare function seal(opts: {
  content: Uint8Array
  recipients: Uint8Array[]
  to: unknown
  from?: unknown
  hub: Address
  ref?: string
  chainId?: number
  random?: (n: number) => Uint8Array
}): Uint8Array
export declare function open(opts: {
  payload: Uint8Array
  secretKey: Uint8Array
  to: unknown
  from?: unknown
  hub: Address
  ref?: string
  chainId?: number
}): { kind: 'public' | 'sealed'; content: Uint8Array }
export declare function messageId(opts: { chainId?: number; hub: Address; to: unknown; inboxIndex: BigNumberish }): string
export declare function sendTx(opts: { hub: Address; circuits: Address; tokenId: BigNumberish; to: unknown; ref?: string; payload: Uint8Array; chainId?: number }): TxRequest
