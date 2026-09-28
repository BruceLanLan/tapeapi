// Read privacy for ChannelBus: busReader with contract-wide reads (default), cover rooms, or plain. See
// docs/guides/channels.md, "Read privacy". It lowers how easily a node links your IP to your rooms; it does not hide them.
// The whole subpath is Experimental in 1.0 (review RC-7): options, defaults and stats().privacy may change in a 1.x minor.
import type { Address } from './common.js'
import type { Rpc } from './rpc.js'
import type { BusOptions, RandomBytes } from './channel.js'

/** @experimental */
export type BusPrivacyMode = 'cover' | 'contract' | 'plain'
/** @experimental */
export declare const BUS_PRIVACY_MODES: readonly BusPrivacyMode[]
/** @experimental */
export declare const DEFAULT_COVER_K: number
/** @experimental */
export declare const MAX_COVER_TOPICS: number
/** @experimental */
export declare const DEFAULT_POOL_BLOCKS: number
/** @experimental */
export declare const DEFAULT_POOL_SPAN: number
/** @experimental */
export declare const DEFAULT_POOL_BYTES: number
/** @experimental */
export declare const DEFAULT_POOL_REFRESH_MS: number
/** @experimental */
export declare const POOL_MAX_ROOMS: number
/** @experimental */
export declare const DEFAULT_CONTRACT_BUDGET: { readonly maxBytes: number; readonly maxLogs: number }
/** @experimental */
export declare const DEFAULT_CONTRACT_RETRY_MS: number
/** @experimental */
export declare const MAX_CONTRACT_RETRY_MS: number

/** Any key-value store, sync or async (a Map works); keeps the cover pool and the covers across restarts. @experimental */
export interface CoverStore {
  get(key: string): unknown
  set(key: string, value: unknown): unknown
}
/** @experimental */
export interface CoverOptions {
  /** Rooms per room of yours, yours included (default 8): a node's best guess from one request is 1 in k. */
  k?: number
  /** Extra room ids (for example channel.inboxRoom() of containers you know), merged with the chain scan. */
  pool?: string[] | (() => string[] | Promise<string[]>)
  /** Blocks of recent bus logs the pool is read from (default 40000; 0: no chain scan). */
  scanBlocks?: number
  scanSpan?: number
  scanBytes?: number
  refreshMs?: number
  /** Room topics per request, at most (default 128; nodes refuse about 1000). */
  maxTopics?: number
  /** Too few covers: 'warn' reads with what there is and says so; 'error' throws BUS_PRIVACY before sending. */
  onShort?: 'warn' | 'error'
  store?: CoverStore
  random?: RandomBytes
}
/** @experimental */
export interface ContractOptions {
  /** Download allowed per poll in 'contract' mode (defaults 8 MiB and 10000 logs). */
  maxBytes?: number
  maxLogs?: number
  /** Over the budget: 'cover' (default) falls back and warns; 'error' stops the reader with BUS_BUDGET until setMode(). */
  onExceed?: 'cover' | 'error'
  /** After a fallback, the least time in 'cover' before trying 'contract' again (default 30 min, doubled after each
   *  quick relapse, at most 24 h); it also waits for traffic under half the budget. null: never come back. */
  retryMs?: number | null
}
/** @experimental */
export interface BusPrivacyStats {
  mode: BusPrivacyMode
  k: number
  /** Rooms each room of yours hides among right now (1 = none; null in 'contract' mode, where no room is named). */
  effectiveK: number | null
  short: boolean
  rooms: number
  covers: number
  pool: number
  poolFrom: number | null
  poolTo: number | null
  poolComplete: boolean
  requests: number
  dropped: number
  lastPoll: { bytes: number; logs: number }
  downloaded: { bytes: number; logs: number }
  stopped: boolean
  /** Set while in 'cover' after a budget fallback: when, how many quick relapses, and the earliest return (null: never). */
  fallback: { since: number; strikes: number; retryAt: number | null } | null
}
/** @experimental */
export type RoomHandler = (wire: Uint8Array, meta: { room: string }) => unknown
/** @experimental */
export interface BusPrivacyReader {
  add(room: string, handler?: RoomHandler | null, opts?: { fromBlock?: number }): void
  remove(room: string): void
  poll(): Promise<Array<{ room: string; wire: Uint8Array }>>
  start(onWire?: RoomHandler, opts?: { onError?: (e: unknown) => void }): void
  stop(): void
  setMode(mode: BusPrivacyMode): void
  readonly mode: BusPrivacyMode
  readonly rooms: string[]
  readonly catchingUp: Record<string, number | null>
  readonly cursor: number | null
  readonly oldestServed: number | null
  /** The covers in use, per room of yours. */
  readonly covers: Record<string, string[]>
  stats(): Record<string, unknown> & { privacy: BusPrivacyStats }
}
/** busReader with contract-wide reads (default), cover rooms, or plain; the busReader options apply. @experimental */
export declare function busPrivacyReader(opts: Partial<BusOptions> & {
  rpc: Rpc
  bus: Address
  rooms?: string[] | Record<string, RoomHandler | null>
  mode?: BusPrivacyMode
  cover?: CoverOptions
  contract?: ContractOptions
}): BusPrivacyReader
/** The rooms seen in a bus's recent Wire logs, read with queries that name no room. @experimental */
export declare function scanCoverPool(opts: {
  rpc: Rpc
  bus: Address
  blocks?: number
  span?: number
  maxBytes?: number
  since?: number | null
  head?: number
}): Promise<{ from: number; to: number; rooms: Array<[string, number]>; logs: number; bytes: number; complete: boolean }>
/** Whether a room id can be a sha256 output (at most four zero bytes). @experimental */
export declare function plausibleRoom(room: string): boolean
