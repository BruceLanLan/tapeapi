import type { FetchLike, Hex, Address } from './common.js'

export declare const RPC_BODY_LIMIT: number

export interface RpcOptions {
  /** JSON-RPC node URLs; must be at least `quorum` distinct URLs, run by at least `quorum` distinct operators
   *  (see `operatorOf`), unless `allowSingleNode` is true. */
  urls: readonly string[]
  /** How many independent operators must answer, all with the same answer (default 2). URLs of one operator count once. */
  quorum?: number
  timeoutMs?: number
  fetch?: FetchLike
  /** Development only: accept fewer nodes than `quorum`. */
  allowSingleNode?: boolean
  bodyLimit?: number
  disagreeRetryMs?: number
  maxHeadSpread?: number
  /** Silence the "quorum equals node count" warning. */
  quiet?: boolean
  warn?: (...args: unknown[]) => void
  /** Ms before a request whose connection broke (not a timeout) is sent once more (default 250; <= 0: never). */
  transportRetryMs?: number
}

/** A quorum JSON-RPC client: every answer is agreed by nodes of `quorum` distinct operators or the call throws. */
/** @experimental (TAP-10 conformance) How one read is adopted. `answers: 'tap10'`: only a result or an execution revert
 *  is an answer (TAP-10 §1); any other JSON-RPC error is a node failure. `strict`: TAP-10 §5.2 strict agreement, from
 *  at least max(2, min(3, operators)) operators. */
export interface ReadOptions {
  answers?: 'tap10'
  strict?: boolean
}

/** @experimental (TAP-10 §5.3) A TAP-10 pinned block. */
export interface Tap10Block {
  number: number
  hash: Hex
  timestamp: number
  tag: 'tap10'
  /** The highest operator head minus `number`. */
  lag: number
  maxLag: number
  /** Each answering operator's lowest head. */
  heads: Record<string, number>
  operators: number
  stateRoot?: Hex
}

export interface Rpc {
  call(method: string, params?: unknown[], opts?: { project?: (result: unknown) => unknown } & ReadOptions): Promise<any>
  /** `block`: a tag, a hex block number, or an EIP-1898 object ({ blockHash, requireCanonical } / { blockNumber }). */
  ethCall(to: Address, data: Hex, block?: string | { blockHash: Hex; requireCanonical?: boolean } | { blockNumber: Hex }, opts?: ReadOptions): Promise<Hex>
  blockNumber(): Promise<number>
  /** @experimental (security 1.1) A block nodes of `quorum` operators confirm, starting from `tag` (default 'finalized').
   *  Freshness is the caller's check. A read pinned to a block (EIP-1898 blockHash or a hex number) that a node answers
   *  with "header not found" / "unknown block" / -32001 counts as that node not answering; every node that answers must
   *  still agree. `{ stateRoot: true }` (@experimental, security 1.2): the block's stateRoot is returned when nodes of
   *  `quorum` operators report it (undefined otherwise); a node that leaves it out is not counted, and one that reports
   *  another stateRoot for the block is RPC_DISAGREE. */
  confirmedBlock(tag?: 'finalized' | 'safe' | 'latest', opts?: { stateRoot?: boolean }): Promise<{ number: number; hash: Hex; timestamp: number; tag: string; operators: number; stateRoot?: Hex }>
  /** @experimental (TAP-10 §5.3) Every node's head, the Q-th highest operator head (Q = min(2, operators); each operator at
   *  its lowest head) minus 2, rejected as RPC_STALE (data.status 'stale-block') when the highest head is more than `maxLag`
   *  blocks ahead; then the block by number from every node, unanimous, so reads can pin to its hash. No clock is used. */
  tap10Block(opts: { maxLag: number; stateRoot?: boolean; graceMs?: number }): Promise<Tap10Block>
  chainId(): Promise<number>
  /** A single-node client over one of this client's URLs. */
  single(url: string, opts?: { bodyLimit?: number }): Rpc
  readonly urls: string[]
  /** The distinct operators behind `urls` (operatorOf), in first-seen order. */
  readonly operators: string[]
  readonly quorum: number
  readonly degraded: boolean
  readonly bodyLimit: number
}

export declare function createRpc(opts: RpcOptions): Rpc
