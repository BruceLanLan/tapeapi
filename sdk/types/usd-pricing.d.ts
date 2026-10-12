// @experimental Prices in US dollars paid in BEM: the TAP draft "Payment Vouchers for Container Services"
// (TapeOutProtocol/TAPs#52). Internal and unreleased: every name may change with the TAP.
import type { Address } from './common.js'

/** @experimental */ export declare const BEM_ADDRESS: Address
/** @experimental */ export declare const SETTLEMENT_CHAIN_ID: 56
/** @experimental */ export declare const DEFAULT_USD_TOKENS: readonly Address[]
/** @experimental §6 */ export declare const BAD_VOUCHER_REASONS: readonly ['malformed', 'provider', 'expired', 'lifetime', 'signature', 'rate', 'stale', 'insufficient', 'funds']
/** @experimental */ export declare const USD_PRICE_RE: RegExp
/** @experimental */ export declare const RATE_RE: RegExp
/** @experimental */ export declare const BASE_UNIT_RE: RegExp
/** @experimental */ export declare const AMOUNT_RE: RegExp
/** @experimental */ export declare const MAX_UINT256: bigint
/** @experimental */ export declare const TOLERANCE_BPS: { readonly min: number; readonly max: number }
/** @experimental */ export declare const MAX_QUOTE_S: { readonly min: number; readonly max: number }
/** @experimental */ export declare const TWAP_WINDOW_S: { readonly min: number; readonly max: number }

/** @experimental { currency, amount } with exactly 8 fraction digits (§1). */
export interface AmountObject { currency: 'BEM' | 'USD' | string; amount: string }
/** @experimental A quote (§4.4). */
export interface Quote { rate: string; asOf: number; validUntil: number }
/** @experimental A `v3-twap` rate source (§4.5). */
export interface RateSource { type: 'v3-twap'; pool: Address; usd: Address; window: number }
/** @experimental The normalised `usdPricing` member (§4.1). */
export interface UsdPricing { methods: Record<string, string>; toleranceBps: number; maxQuoteS: number; rateSources: RateSource[] }
/** @experimental The charge record, the member `charge` of a priced result (§7). */
export interface ChargeRecord {
  consumer: Address
  cumulative: string
  amount: AmountObject
  price?: AmountObject
  rate?: string
  rateAsOf?: number
  capped?: true
  quote?: Quote
}
/** @experimental One source's reading (§4.5); `reason` when it gave no rate. */
export interface SourceReading {
  pool: Address; usd: Address; window: number
  bemIsToken0?: boolean; usdDecimals?: number; meanTick?: string; rate?: number
  reason?: 'tokens' | 'decimals' | 'observe' | 'range' | 'read'; detail?: string
}

/** @experimental */ export declare function parseUsdPrice(s: string): bigint
/** @experimental */ export declare function parseRate(s: string): bigint
/** @experimental */ export declare function formatAmount8(n: bigint | number | string): string
/** @experimental */ export declare function amountObject(n: bigint | number | string, currency?: string): AmountObject
/** @experimental */ export declare function amountValue(o: unknown, currency: string): bigint | null
/** @experimental §4.3 exact conversion. */
export declare function convertUsd(a: { priceUSD: string; rate: string; priceBEM: string }): { U: bigint; R: bigint; P: bigint; converted: bigint; charge: bigint; capped: boolean }
/** @experimental §4.1; null when the manifest has no `usdPricing`; throws MANIFEST_INVALID. */
export declare function validateUsdPricing(manifest: unknown, opts?: { usdTokens?: readonly string[] | null }): UsdPricing | null
/** @experimental Never throws. */
export declare function usdPricingOf(manifest: unknown, opts?: { usdTokens?: readonly string[] | null }): { usdPricing: UsdPricing } | { error: Error } | null
/** @experimental §4.4; throws BAD_QUOTE. */
export declare function validateQuote(q: unknown, opts?: { maxQuoteS?: number; ts?: number }): Quote
/** @experimental */ export declare function encodeObserve(window: number): string
/** @experimental */ export declare function decodeObserve(hex: string): [bigint, bigint]
/** @experimental */ export declare function meanTick(tickCumulatives: readonly [bigint | string | number, bigint | string | number], window: number | bigint): bigint
/** @experimental */ export declare function rateFromTick(tick: bigint | number | string, o: { bemIsToken0: boolean; usdDecimals: number; bemDecimals?: number }): number
/** @experimental */ export declare function median(xs: readonly number[]): number | null
/** @experimental §4.5 client check. */
export declare function quotePasses(rate: string, reference: number, toleranceBps: number): boolean
/** @experimental */ export declare function formatRate(x: number): string
/** @experimental §4.5: every source at one block agreed under TAP-10, reads pinned to its hash. */
export declare function readReferenceRates(
  rpc: { ethCall(to: string, data: string, block?: unknown, opts?: unknown): Promise<string>; confirmedBlock(tag?: string): Promise<{ number: number; hash: string; timestamp: number }> },
  sources: readonly RateSource[],
  opts?: { block?: { number: number; hash: string; timestamp: number }; maxAgeS?: number; now?: number; bem?: string; strict?: boolean },
): Promise<{ block: { number: number; hash: string; timestamp: number }; sources: SourceReading[]; reference: number | null }>
/** @experimental §7 */
export declare function chargeRecord(a: { consumer: string; cumulative: bigint | string; amount: bigint | string; usd?: { priceUSD: string; rate: string; rateAsOf: number; capped: boolean }; quote?: Quote }): ChargeRecord
/** @experimental §8.3 */
export declare function checkChargeRecord(charge: unknown, o: { voucher: { consumer: string; cumulative: string; rate?: string }; last: bigint | string; usd?: { priceUSD: string; priceBEM: string } }): { ok: true } | { ok: false; kind: 'unbound' | 'fault'; why: string }
/** @experimental §3.2 wire form; null when well formed. */
export declare function voucherWireProblem(v: unknown): string | null
/** @experimental v 0/1 → 27/28 */
export declare function normaliseV(sig: string): string
