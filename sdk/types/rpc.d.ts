import type { FetchLike, Hex, Address } from './common.js'

export declare const RPC_BODY_LIMIT: number

export interface RpcOptions {
  /** JSON-RPC node URLs; must be at least `quorum` distinct URLs, run by at least `quorum` distinct operators
   *  (see `operatorOf`), unless `allowSingleNode` is true. */
  urls: string[]
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
  ethCall(to: Address, data: Hex, block?: string): Promise<Hex>
  blockNumber(): Promise<number>
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
export declare function describeUrl(url: string, index: number): string
export declare function readJsonBounded(res: { body?: unknown; text?: () => Promise<string>; [k: string]: any }, limit: number, opts?: { code?: string }): Promise<any>
export declare function isNodeLimit(error: unknown): boolean
