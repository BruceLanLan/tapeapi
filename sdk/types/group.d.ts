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
/**
 * A group handle; methods depend on the role (owner or member). The owner's addMembers / removeMembers / rotate
 * resolve to a GroupUpdate. owner.inviteFor(member) seals the invite for the member's INBOX room
 * (channel.inboxRoom(container, chainId): the container, never the holder's wallet), not the group room;
 * owner.epochWire is the latest epoch message, for reposts. Prefer deliverGroupUpdate, which posts both.
 */
export type Group = Record<string, any>
/**
 * What a membership change produced. TWO ROOMS: `epochWire` goes to the GROUP room (group.room); every member in
 * `added` also needs group.inviteFor(member) in ITS OWN inbox room, or it never learns of the group.
 * deliverGroupUpdate({ group, update }) posts both and reports each post.
 */
export interface GroupUpdate {
  epochWire: Uint8Array
  epoch: number
  /** Containers dropped because their channel record no longer matches (§3.6). */
  dropped: Address[]
  /** The roster entries this epoch brought in: each needs an invite in its inbox room. */
  added: Array<{ container: Address; chainId: number; x25519: string; ed25519: string }>
}

export declare function groupRoom(gid: Uint8Array | string): string
export declare function senderKey(K: Uint8Array, gid: Uint8Array, epoch: number, index: number): Uint8Array
export declare function buildEpoch(opts: Record<string, unknown>): { wire: Uint8Array; K: Uint8Array; roster: unknown; rosterBytes: Uint8Array }
/**
 * Owner: create a group. TWO ROOMS: post `epochWire` to group.room AND group.inviteFor(m) to each member's inbox room
 * (channel.inboxRoom(m.container, m.chainId)) -- or call deliverGroupUpdate({ group, update }), which does both.
 */
export declare function createGroup(opts: {
  self: { container: Address; chainId?: number }
  identity: Identity
  members?: GroupMember[]
  relays?: RelayRef[]
  bus?: unknown
  verifyMember?: MemberVerifier
  random?: RandomBytes
  now?: () => number
}): Promise<{ group: Group; epochWire: Uint8Array; epoch: number; added: GroupUpdate['added'] }>
/** Owner after a restart: starts the next epoch at once; `added` is empty (members already joined). */
export declare function resumeGroup(opts: {
  self: { container: Address; chainId?: number }
  identity: Identity
  snapshot: Record<string, unknown>
  relays?: RelayRef[]
  bus?: unknown
  verifyMember?: MemberVerifier
  random?: RandomBytes
}): Promise<GroupUpdate & { group: Group }>
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
