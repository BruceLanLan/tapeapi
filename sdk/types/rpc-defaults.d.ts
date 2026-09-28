/** One default node: its URL and who operates it. */
export interface RpcNode {
  readonly url: string
  readonly operator: string
}

/** Default JSON-RPC nodes per chain id, each of a distinct operator (chain 56: NodeReal, Alchemy, 48 Club). */
export declare const RPC_DEFAULTS: Readonly<Record<number, readonly RpcNode[]>>

/** The default node URLs for a chain, as a fresh array; [] for a chain without defaults. */
export declare function rpcUrlsFor(chainId: number): string[]

/** Who operates the node at `url`: a known operator's name (e.g. 'nodereal' for every bsc-dataseed host), else the
 *  URL's hostname. createRpc counts agreement by these, never by URL. */
export declare function operatorOf(url: string): string
