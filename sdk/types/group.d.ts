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
/** One roster entry as a group handle reports it (lowercase hex keys). */
export interface RosterMember { container: Address; chainId: number; x25519: string; ed25519: string }
/** The signed roster of one epoch (TAP-27 §3.2); loose beyond the fields every client reads. */
export interface Roster { v?: number; gid: string; epoch: number; issued: number; owner: { container: Address; chainId: number }; members: RosterMember[]; relays?: RelayRef[]; bus?: unknown; [key: string]: unknown }
/** What to keep across a restart (no secrets). `roster` is present for an owner, `lastSeq` once a message was sealed. */
export interface GroupSnapshot { v: 1; gid: string; owner: { container: Address; chainId: number }; epoch: number | null; role: 'owner' | 'member'; lastSeq?: string; roster?: string }
/** A message opened with group.open(): or { own: true, epoch, seq } for our own message coming back. */
export type OpenedGroupMessage =
  | { from: Address; index: number; epoch: number; seq: bigint; gap: number | null; data: Uint8Array | string; own?: undefined }
  | { own: true; epoch: number; seq: bigint }

/** A TAP-27 group handle, owner or member (joinGroup). */
export interface GroupHandle {
  /** The group id: 16 bytes, lowercase hex. */
  readonly gid: string
  /** The group room (epoch messages and group messages go here). */
  readonly room: string
  readonly isOwner: boolean
  /** The current epoch, or null before the first one was accepted. */
  readonly epoch: number | null
  readonly roster: Roster | null
  /** A copy of the current members. */
  readonly members: RosterMember[]
  snapshot(): GroupSnapshot
  /** §3.3: check an epoch message and move to its epoch; calls are serialised. */
  acceptEpoch(wire: Uint8Array, opts?: { verifyMember?: MemberVerifier | 'trust-roster' }): Promise<{ epoch: number; roster: Roster; duplicate?: true }>
  /** §3.4: encrypt and sign a message for the current epoch. */
  seal(data: Uint8Array | string, opts?: { random?: RandomBytes }): Uint8Array
  /** §3.4: verify and decrypt (`data` is text with { text: true }). */
  open(wire: Uint8Array, opts?: { text?: boolean }): OpenedGroupMessage
}

/**
 * The owner's handle (createGroup / resumeGroup). addMembers / removeMembers / rotate resolve to a GroupUpdate.
 * inviteFor(member) seals the invite for the member's INBOX room (channel.inboxRoom(container, chainId): the container,
 * never the holder's wallet), not the group room; epochWire is the latest epoch message, for reposts. Prefer
 * deliverGroupUpdate, which posts both.
 */
export interface OwnerGroup extends GroupHandle {
  readonly isOwner: true
  /** The latest epoch message, for reposts (§3.5). */
  readonly epochWire: Uint8Array
  addMembers(entries: GroupMember[], opts?: { verifyMember?: MemberVerifier }): Promise<GroupUpdate>
  removeMembers(targets: Array<Address | { container: Address; chainId?: number }>, opts?: { verifyMember?: MemberVerifier }): Promise<GroupUpdate>
  /** A new epoch key with the same members (at least every 30 days). */
  rotate(opts?: { verifyMember?: MemberVerifier }): Promise<GroupUpdate>
  /** The sealed invite (wire type 0x03) for the member's inbox room. */
  inviteFor(member: Address | { container: Address; chainId?: number }, opts?: { random?: RandomBytes }): Uint8Array
}

/** Either handle. */
export type Group = GroupHandle | OwnerGroup
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
  /** The group's clock: a function returning Unix seconds (fractional allowed); default the system clock. Renamed from
   *  `now` (milliseconds) in 1.0: passing `now` throws INVALID_ARGUMENT, and so does a clock returning more than 1e11
   *  (milliseconds, e.g. Date.now) or not a finite number. */
  clock?: () => number
}): Promise<{ group: OwnerGroup; epochWire: Uint8Array; epoch: number; added: GroupUpdate['added'] }>
/** Owner after a restart: starts the next epoch at once; `added` is empty (members already joined). */
export declare function resumeGroup(opts: {
  self: { container: Address; chainId?: number }
  identity: Identity
  snapshot: GroupSnapshot
  relays?: RelayRef[]
  bus?: unknown
  verifyMember?: MemberVerifier
  random?: RandomBytes
  /** As in createGroup. */
  clock?: () => number
}): Promise<GroupUpdate & { group: OwnerGroup }>
export declare function openGroupInvite(wire: Uint8Array, opts: { self: unknown }): Record<string, unknown>
export declare function joinGroup(opts: {
  self: { container: Address; chainId?: number }
  identity: Identity
  invite: Record<string, unknown>
  ownerKeys?: unknown
  minEpoch?: number
  lastSeq?: string | bigint
  /** As in createGroup. */
  clock?: () => number
}): GroupHandle
