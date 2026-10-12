// Type declarations for @tapeapi/sdk. Hand-written; the JavaScript in ../src is the source of truth.

/**
 * The one error type the SDK throws. `code` is machine-readable; the full table is in docs/guides/upgrade-1.0.md and
 * TAPI-21 §3.4. `INVALID_ARGUMENT` means the caller's own options or arguments are wrong: never retry it.
 *
 * Top-level fields are fixed: `name`, `code`, `message`, `data`, `signed`, `httpStatus`, `cause`, and on a signed
 * provider error the TAPI-21 envelope fields `ts`, `block`, `id`, `sig`, `error`. Every other detail is in `data`
 * (for example `data.tooLarge`, `data.rpcCode`, `data.rpcRevert`, `data.rpcData`, and for `QUORUM_FAILED` /
 * `ATTEST_DISAGREE` `data.quorum`, `data.agreed`, `data.disagreed`, `data.failed`, `data.groups`; for
 * `ATTEST_DISAGREE` also the verified envelopes and the request, `data.envelopes`, `data.request`; for the experimental
 * proof mode's `PROOF_INVALID` / `PROOF_UNAVAILABLE`, `data.read`, `data.address`, `data.reason`, `data.node`,
 * `data.block`, `data.stateRoot`). 2.0 removed the deprecated top-level aliases that 1.x kept for each of these keys:
 * read them under `data` (docs/guides/upgrade-2.0.md).
 *
 * @experimental (1.4) In the conformance mode (the default since 2.0, or `conform: 'tap10'`) every error also carries
 * `data.status`, the TAP-10 / TAP-11 outcome name ('input-error', 'unsupported' (TapeAPI's own name, not a TAP outcome:
 * input without chain information that needs `allChains`), 'ambiguous' (1.5, with
 * `data.candidates` (each with the identity `warnings` it held back, if any) and `data.chains`), 'wrong-chain', 'stale-block', 'unavailable', 'store-changed', 'no-such-cpu', 'no-such-token',
 * 'not-tapeout', 'not-opened', 'unpaid', 'no-manifest', 'incomplete', 'no-hash', 'manifest-invalid', 'delegation-invalid',
 * and TapeAPI's own 'hub-changed', 'container-mismatch'); `SITE_STATUS` (not-opened, unpaid) is the one code the mode adds.
 * With `conform: false` (or `null`, or `dev: true` without `conform: 'tap10'`: the 1.x resolution) `resolve` and the chain reads fail as in 1.x,
 * without `data.status`; `siteStatus`, the TAP-10 path in any mode, carries it in both. Since 2.0 the default's errors
 * are the conformance mode's, not 1.x's: docs/guides/upgrade-2.0.md lists every code that changed.
 *
 * Status names only grow (TAP-11 §2.3): none is renamed or removed, and a new one appears in a minor release. A
 * tightening of the condition behind an existing name is first an optional profile, and the default changes in 3.0.
 * The tag stays in 2.0 because these names follow TAP texts that are still Drafts: see "How the default follows changes
 * in the official TAPs" in docs/guides/upgrade-2.0.md.
 */
export declare class TapeAPIError extends Error {
  constructor(code: string, message?: string, extra?: TapeAPIErrorExtra)
  name: 'TapeAPIError'
  code: string
  /** Details that depend on the code. */
  data?: Record<string, any>
  /** true when the error came in a signed TAPI-21 envelope (a provider's statement, verified). */
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
