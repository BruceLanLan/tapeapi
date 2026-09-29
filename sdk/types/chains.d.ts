import type { Address } from './common.js'

/** One TapeOut chain TapeAPI reads (TapeKit kernel/src/config.js; every address checked on chain 2026-09-28). */
export interface TapeOutChain {
  readonly chainId: number
  /** Short key: 'bnb', 'xlayer', 'base'. */
  readonly key: string
  readonly name: string
  readonly currency: string
  /** Area code in names: null on BNB Smart Chain (no area code), 2 on X Layer, 3 on Base. */
  readonly area: number | null
  readonly nameSuffix: string
  /** TapeOut processor factory: cpuAt(i), isCPU(circuits). */
  readonly factory: Address
  /** Container opener: accountOf, isOpened. */
  readonly opener: Address
  /** DeWebHub (same proxy address on every chain): derives containers, and is the delegation verifyingContract. */
  readonly hub: Address
  readonly siteRegistry: Address
  readonly binding: Address
  readonly erc6551Registry: Address
  readonly accountImplementation: Address
  /** Proxy (lowercase) -> audited implementations (lowercase), read from the ERC-1967 slot. */
  readonly expectedImpl: Readonly<Record<string, readonly string[]>>
  /** The TAP-20 delegation domain's chainId and verifyingContract on this chain. */
  readonly delegation: { readonly chainId: number; readonly verifyingContract: Address }
  readonly pin: string
  readonly finality: string
  readonly maxPinLagBlocks: number
  /** @experimental (security 1.1) The oldest pinned block, in seconds of its timestamp, a pinned resolution accepts. */
  readonly maxPinAgeS: number
  /** Whether TapeAPI payments (escrow, BEM) run on this chain: BNB Smart Chain only. */
  readonly payments: boolean
}

export declare const IMPL_SLOT: string
export declare const CHAINS: Readonly<Record<number, TapeOutChain>>
export declare const CHAIN_IDS: readonly number[]
export declare const HOME_CHAIN_ID: 56
export declare function chainById(chainId: number | string): TapeOutChain | null
/** null or undefined is BNB Smart Chain; an unassigned area code is null. */
export declare function chainByArea(area: number | null | undefined): TapeOutChain | null
export declare function chainByKey(key: string): TapeOutChain | null
export declare function isNameShaped(str: unknown): boolean

export interface ParsedTapeName {
  tokenId: string
  processor: string
  area: number | null
  chainId: number
  /** Canonical, with the suffix: '4246.0.tape', '1.2.344.tape'. */
  name: string
}
/** null: not name-shaped; { error }: name-shaped but not a canonical name of a supported chain. */
export declare function parseTapeName(str: unknown): ParsedTapeName | { error: string } | null
export declare function formatTapeName(parts: { tokenId: bigint | number | string; processor: bigint | number | string; chainId?: number }, opts?: { suffix?: boolean }): string
