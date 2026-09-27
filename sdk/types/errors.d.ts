// Type declarations for @tapeapi/sdk. Hand-written; the JavaScript in ../src is the source of truth.

/** The one error type the SDK throws. `code` is machine-readable (e.g. 'RPC_UNAVAILABLE', 'PRICE_CHANGED',
 *  'QUORUM_FAILED', 'BAD_SIGNATURE'); extra fields (`data`, `rpcCode`, `signed`, ...) depend on the code. */
export declare class TapeAPIError extends Error {
  constructor(code: string, message?: string, extra?: Record<string, unknown>)
  name: 'TapeAPIError'
  code: string
  data?: unknown
  [key: string]: unknown
}
