// TAP-27 private group channels. Loose shapes: see docs/guides/channels.md and spec/TAP-27.
import type { Address } from './common.js'
import type { Identity, RelayRef, RandomBytes } from './channel.js'

export declare const GROUP_INVITE_KIND: string
export declare const ROSTER_KIND: string
export declare const MAX_MEMBERS: number
export declare const MAX_EPOCH: number
export declare const MAX_EPOCH_AGE_S: number
export declare const FUTURE_SKEW_S: number
export declare const MAX_PLAINTEXT: number
export declare const MAX_WIRE: number
export declare const WIRE_EPOCH: number
export declare const WIRE_MESSAGE: number
export declare const KEEP_PREVIOUS_MS: number

export interface GroupMember { container: Address; chainId?: number; x25519: string | Uint8Array; ed25519: string | Uint8Array; [key: string]: unknown }
export type MemberVerifier = (member: GroupMember, opts?: { fresh?: boolean }) => Promise<boolean>
/** A group handle; methods depend on the role (owner or member). */
export type Group = Record<string, any>

export declare function groupRoom(gid: Uint8Array | string): string
export declare function senderKey(K: Uint8Array, gid: Uint8Array, epoch: number, index: number): Uint8Array
export declare function buildEpoch(opts: Record<string, unknown>): { wire: Uint8Array; K: Uint8Array; roster: unknown; rosterBytes: Uint8Array }
export declare function createGroup(opts: {
  self: { container: Address; chainId?: number }
  identity: Identity
  members?: GroupMember[]
  relays?: RelayRef[]
  bus?: unknown
  verifyMember?: MemberVerifier
  random?: RandomBytes
  now?: () => number
}): Promise<{ group: Group; epochWire: Uint8Array }>
export declare function resumeGroup(opts: {
  self: { container: Address; chainId?: number }
  identity: Identity
  snapshot: Record<string, unknown>
  relays?: RelayRef[]
  bus?: unknown
  verifyMember?: MemberVerifier
  random?: RandomBytes
}): Promise<{ group: Group; epochWire: Uint8Array; [key: string]: unknown }>
export declare function openGroupInvite(wire: Uint8Array, opts: { self: unknown }): Record<string, unknown>
export declare function joinGroup(opts: {
  self: { container: Address; chainId?: number }
  identity: Identity
  invite: Record<string, unknown>
  ownerKeys?: unknown
  minEpoch?: number
  lastSeq?: unknown
  now?: () => number
}): Group
