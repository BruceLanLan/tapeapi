// Security 1.2 Merkle proofs. Everything here is @experimental: outside the 1.0 stability promise; may change in a 1.x minor release.
import type { Address, Hex } from './common.js'

/** keccak256 of the empty string: the code hash of an account without code. */
export declare const EMPTY_CODE_HASH: Hex
/** keccak256(rlp('')): the root of an empty trie. */
export declare const EMPTY_TRIE_ROOT: Hex
/** A decoded RLP item: bytes, or a list of items (a list carries `rlpLength`, the length of its own encoding). */
export type RlpItem = Uint8Array | (RlpItem[] & { readonly rlpLength: number })
/** @experimental How deep RLP lists may nest (a trie node holds at most 32 levels). */
export declare const RLP_MAX_DEPTH: 64
/** @experimental Decode one canonical RLP item, lists nested at most RLP_MAX_DEPTH deep; any other input throws
 *  PROOF_INVALID (and nothing else). */
export declare function rlpDecode(bytes: Uint8Array): RlpItem
/** @experimental Verify a Merkle-Patricia proof (nodes from the root down, as eth_getProof lists them): the value under
 *  `key`, or null when the proof shows the key absent. `secure`: Ethereum's state and storage tries (the caller passes
 *  keccak256 of the key). Any bad input throws PROOF_INVALID, and nothing else. */
export declare function verifyMptProof(root: Hex | Uint8Array, key: Hex | Uint8Array, proof: Array<Hex | Uint8Array>, opts?: { secure?: boolean }): Uint8Array | null
/** An EIP-1186 eth_getProof answer. */
export interface GetProofAnswer {
  address?: Address
  accountProof: Hex[]
  storageHash?: Hex
  storageProof: Array<{ key: Hex; value: Hex; proof: Hex[] }>
  [key: string]: unknown
}
/** @experimental Check one eth_getProof answer against `stateRoot`: the account and the value of each slot (0n when
 *  absent). The answer's storageHash, keys and values must equal what the proof shows. Throws PROOF_INVALID. */
export declare function verifyAccountProof(stateRoot: Hex, address: Address, slots: Array<bigint | Hex | number>, answer: GetProofAnswer): {
  account: { exists: boolean; nonce: bigint; balance: bigint; storageRoot: Hex; codeHash: Hex }
  values: Map<bigint, bigint>
}
/** @experimental The implementations whose storage layout is known (measured 2026-09-30), per proxy role. */
export declare const LAYOUT_IMPLEMENTATIONS: { readonly siteRegistry: readonly string[]; readonly factory: readonly string[] }
/** @experimental The storage slots of the reads resolve can prove. */
export declare const STORAGE: {
  /** SiteRegistry fileInfo(container, key): `size` is the low 32 bits of its slot. */
  fileInfo(container: Address, key: string): { size: bigint; sha256Hash: bigint }
  ownerOf(tokenId: bigint | number | string): bigint
  cpuAt(n: bigint | number | string): { length: bigint; element: bigint }
  isCPU(circuits: Address): bigint
}
/** @experimental The address a word holds (lower case), or null when its high 12 bytes are not zero. */
export declare function addressOfWord(v: bigint | Hex): Address | null
