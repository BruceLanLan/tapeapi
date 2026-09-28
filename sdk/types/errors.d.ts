// Type declarations for @tapeapi/sdk. Hand-written; the JavaScript in ../src is the source of truth.

/**
 * The one error type the SDK throws. `code` is machine-readable; the full table is in docs/guides/upgrade-1.0.md and
 * TAP-21 §3.4. `INVALID_ARGUMENT` means the caller's own options or arguments are wrong: never retry it.
 *
 * Top-level fields are fixed for 1.x: `name`, `code`, `message`, `data`, `signed`, `httpStatus`, `cause`, and on a
 * signed provider error the TAP-21 envelope fields `ts`, `block`, `id`, `sig`, `error`. Every other detail is in `data`
 * (for example `data.tooLarge`, `data.rpcCode`, `data.rpcRevert`, `data.rpcData`, and for `QUORUM_FAILED` /
 * `ATTEST_DISAGREE` `data.quorum`, `data.agreed`, `data.disagreed`, `data.failed`, `data.groups`).
 */
export declare class TapeAPIError extends Error {
  constructor(code: string, message?: string, extra?: TapeAPIErrorExtra)
  name: 'TapeAPIError'
  code: string
  /** Details that depend on the code. */
  data?: Record<string, any>
  /** true when the error came in a signed TAP-21 envelope (a provider's statement, verified). */
  signed?: boolean
  /** The HTTP status the answer came with, when there was one. */
  httpStatus?: number
  cause?: unknown
  /** Signed provider errors only: the envelope's fields. */
  ts?: number
  block?: unknown
  id?: string
  sig?: string
  error?: { code: string; message?: string; data?: Record<string, unknown> }
  /** @deprecated 0.x top-level alias, removed in 2.0: read `data.tooLarge`. */
  readonly tooLarge?: boolean
  /** @deprecated 0.x top-level alias, removed in 2.0: read `data.rpcCode`. */
  readonly rpcCode?: number
  /** @deprecated 0.x top-level alias, removed in 2.0: read `data.rpcRevert`. */
  readonly rpcRevert?: boolean
  /** @deprecated 0.x top-level alias, removed in 2.0: read `data.rpcData`. */
  readonly rpcData?: unknown
  /** @deprecated 0.x top-level alias, removed in 2.0: read `data.quorum`. */
  readonly quorum?: number
  /** @deprecated 0.x top-level alias, removed in 2.0: read `data.agreed`. */
  readonly agreed?: string[]
  /** @deprecated 0.x top-level alias, removed in 2.0: read `data.disagreed`. */
  readonly disagreed?: string[]
  /** @deprecated 0.x top-level alias, removed in 2.0: read `data.failed`. */
  readonly failed?: Array<{ container: string; code: string; message: string }>
  /** @deprecated 0.x top-level alias, removed in 2.0: read `data.groups`. */
  readonly groups?: Array<{ result: unknown; containers: string[] }>
  /** @deprecated 0.x top-level alias, removed in 2.0: read `data.reason`. */
  readonly reason?: string
}

/** What a thrower may attach: the fixed top-level fields, plus any other key, which is stored in `data`. */
export type TapeAPIErrorExtra = {
  data?: Record<string, unknown>
  signed?: boolean
  httpStatus?: number
  cause?: unknown
  ts?: number
  block?: unknown
  id?: string
  sig?: string
  error?: { code: string; message?: string; data?: Record<string, unknown> }
  [key: string]: unknown
}
