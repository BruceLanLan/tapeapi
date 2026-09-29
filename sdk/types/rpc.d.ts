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
}

/** A quorum JSON-RPC client: every answer is agreed by nodes of `quorum` distinct operators or the call throws. */
export interface Rpc {
  call(method: string, params?: unknown[], opts?: { project?: (result: unknown) => unknown }): Promise<any>
  /** `block`: a tag, a hex block number, or an EIP-1898 object ({ blockHash, requireCanonical } / { blockNumber }). */
  ethCall(to: Address, data: Hex, block?: string | { blockHash: Hex; requireCanonical?: boolean } | { blockNumber: Hex }): Promise<Hex>
  blockNumber(): Promise<number>
  /** @experimental (security 1.1) A block nodes of `quorum` operators confirm, starting from `tag` (default 'finalized').
   *  Freshness is the caller's check. A read pinned to a block (EIP-1898 blockHash or a hex number) that a node answers
   *  with "header not found" / "unknown block" / -32001 counts as that node not answering; every node that answers must
   *  still agree. */
  confirmedBlock(tag?: 'finalized' | 'safe' | 'latest'): Promise<{ number: number; hash: Hex; timestamp: number; tag: string; operators: number }>
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
