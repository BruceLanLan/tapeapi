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
/** How many §3.3 step 6 checks (one channel-record read each) run at once by default: 8. Since 1.1.x. */
export declare const VERIFY_CONCURRENCY: number
/** @experimental TAP-27 §3.8: the high half of a format-2 epoch field (0x54470200). */
export declare const FORMAT_V2_MARK: number
/** @experimental TAP-27 §3.8: members of a format-2 group (128). */
export declare const MAX_MEMBERS_V2: number
/** @experimental TAP-27 §3.8: how long a POSITIVE verdict on a roster entry is reused, at most and by default (86,400 s), from the start of its check. */
export declare const VERIFY_REUSE_S: number
/** @experimental TAP-27 §3.8: how long a NEGATIVE verdict (definitively does not match) is kept, at most (60 s). */
export declare const VERIFY_NEGATIVE_S: number

export interface GroupMember { container: Address; chainId?: number; x25519: string | Uint8Array; ed25519: string | Uint8Array; [key: string]: unknown }
export type MemberVerifier = (member: GroupMember, opts?: { fresh?: boolean }) => Promise<boolean>
/** One roster entry as a group handle reports it (lowercase hex keys). */
export interface RosterMember { container: Address; chainId: number; x25519: string; ed25519: string }
/** The signed roster of one epoch (TAP-27 §3.2); loose beyond the fields every client reads. */
export interface Roster { v?: number; gid: string; epoch: number; issued: number; owner: { container: Address; chainId: number }; members: RosterMember[]; relays?: RelayRef[]; bus?: unknown; [key: string]: unknown }
/** What to keep across a restart (no secrets). `roster` is present for an owner, `lastSeq` once a message was sealed. */
/** A format-1 snapshot (no `format`). */
export type GroupSnapshotV1 = Omit<GroupSnapshot, 'format' | 'rosterBin'> & { format?: undefined }
/** @experimental A format-2 snapshot. */
export type GroupSnapshotV2 = GroupSnapshot & { format: 2 }
export interface GroupSnapshot { v: 1; gid: string; owner: { container: Address; chainId: number }; epoch: number | null; role: 'owner' | 'member'; lastSeq?: string; roster?: string; /** @experimental format 2 only */ format?: 2; /** @experimental format 2 owner only: the roster bytes as sent (hex) */ rosterBin?: string }
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
  /** 1 (TAP-27 v1, the default) or 2 (TAP-27 §3.8, @experimental). */
  readonly format: 1 | 2
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
/** @experimental Owner: create a format-2 group (TAP-27 §3.8, up to 128 members). Members still need x25519 (the owner wraps their slots). */
export declare function createGroup(opts: {
  format: 2
  self: { container: Address; chainId?: number }
  identity: Identity
  members?: GroupMember[]
  relays?: RelayRef[]
  bus?: unknown
  verifyMember?: MemberVerifier | MemberVerifierV2
  random?: RandomBytes
  clock?: () => number
  verifyConcurrency?: number
}): Promise<{ group: OwnerGroupV2; epochWire: Uint8Array; epoch: number; added: GroupUpdate['added'] }>
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
  /** How many member checks (§3.3 step 6, one channel-record read each) run at once: an integer in 1..64, default
   *  VERIFY_CONCURRENCY (8). The outcome is the serial loop's: the error is the first failing member's in roster order. */
  verifyConcurrency?: number
}): Promise<{ group: OwnerGroup; epochWire: Uint8Array; epoch: number; added: GroupUpdate['added'] }>
/** Owner after a restart: starts the next epoch at once; `added` is empty (members already joined). */
export declare function resumeGroup(opts: {
  self: { container: Address; chainId?: number }
  identity: Identity
  snapshot: GroupSnapshotV1
  relays?: RelayRef[]
  bus?: unknown
  verifyMember?: MemberVerifier
  random?: RandomBytes
  clock?: () => number
  verifyConcurrency?: number
}): Promise<GroupUpdate & { group: OwnerGroup }>
/** @experimental Owner of a format-2 group after a restart (a snapshot with `format: 2`). */
export declare function resumeGroup(opts: {
  self: { container: Address; chainId?: number }
  identity: Identity
  snapshot: GroupSnapshotV2
  relays?: RelayRef[]
  bus?: unknown
  verifyMember?: MemberVerifier | MemberVerifierV2
  random?: RandomBytes
  clock?: () => number
  verifyConcurrency?: number
}): Promise<GroupUpdate & { group: OwnerGroupV2 }>
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
  /** As in createGroup. */
  verifyConcurrency?: number
}): Promise<GroupUpdate & { group: OwnerGroup }>
export declare function openGroupInvite(wire: Uint8Array, opts: { self: unknown }): Record<string, unknown>
/**
 * @experimental Member of a format-2 group (the invite says `format: 2`; say it here too for this type). `verifyMember`
 * is the default for the lazy checks (group.channelKeysVerifier(api), NOT api.groupVerifier(), which compares an x25519 key
 * format-2 entries do not carry); `verifyReuseS` (0..86400, default 86400) is how long a positive verdict is reused. A
 * negative verdict is kept at most VERIFY_NEGATIVE_S (60 s).
 */
export declare function joinGroup(opts: {
  format: 2
  self: { container: Address; chainId?: number }
  identity: Identity
  invite: Record<string, unknown>
  ownerKeys?: unknown
  minEpoch?: number
  lastSeq?: string | bigint
  clock?: () => number
  verifyConcurrency?: number
  verifyMember?: MemberVerifierV2 | 'trust-roster'
  verifyReuseS?: number
}): GroupHandleV2
export declare function joinGroup(opts: {
  self: { container: Address; chainId?: number }
  identity: Identity
  invite: Record<string, unknown>
  ownerKeys?: unknown
  minEpoch?: number
  lastSeq?: string | bigint
  /** As in createGroup. */
  clock?: () => number
  /** As in createGroup. */
  verifyConcurrency?: number
  /** Format-2 options: a format-1 group ignores them, as 1.1.0 did (pass them to any invite). */
  verifyMember?: MemberVerifierV2 | 'trust-roster'
  verifyReuseS?: number
}): GroupHandle

// ---------------------------------------------------------------- @experimental: TAP-27 §3.8, format 2 ----
/** @experimental A format-2 roster entry: no x25519 (only the owner's own list keeps it), and its verification state. */
export interface RosterMemberV2 { container: Address; chainId: number; ed25519: string; x25519?: string; verified: boolean; mismatch?: true }
/** @experimental The roster of a format-2 epoch. */
export interface RosterV2 { format: 2; gid: string; epoch: number; issued: number; prev: string; owner: { container: Address; chainId: number }; members: RosterMemberV2[]; relays: RelayRef[]; bus?: string }
/** @experimental The member a format-2 verifier is asked about: x25519 only on the owner's side. */
export interface GroupEntryV2 { container: Address; chainId: number; ed25519: string; x25519?: string }
export type MemberVerifierV2 = (member: GroupEntryV2, opts?: { fresh?: boolean }) => Promise<boolean>
/** @experimental A message opened by a format-2 handle: `verified` is false until the sender's entry was checked against its channel record. */
export type OpenedGroupMessageV2 =
  | { from: Address; index: number; epoch: number; seq: bigint; gap: number | null; data: Uint8Array | string; verified: boolean; verifyError?: { code: string; message: string }; own?: undefined }
  | { own: true; epoch: number; seq: bigint }
/**
 * @experimental A format-2 group handle (TAP-27 §3.8). §3.3 step 6 is lazy: acceptEpoch checks only the owner's entry;
 * open() marks a sender not yet checked as verified: false (show it as unverified); openVerified() checks it first;
 * verifyMembers() checks the rest in the background.
 */
export interface GroupHandleV2 extends Omit<GroupHandle, 'format' | 'roster' | 'members' | 'acceptEpoch' | 'open' | 'snapshot'> {
  readonly format: 2
  snapshot(): GroupSnapshotV2
  readonly roster: RosterV2 | null
  readonly members: RosterMemberV2[]
  acceptEpoch(wire: Uint8Array, opts?: { verifyMember?: MemberVerifierV2 | 'trust-roster' }): Promise<{ epoch: number; roster: RosterV2; unverified?: number; duplicate?: true }>
  open(wire: Uint8Array, opts?: { text?: boolean }): OpenedGroupMessageV2
  openVerified(wire: Uint8Array, opts?: { text?: boolean; verifyMember?: MemberVerifierV2 | 'trust-roster' }): Promise<OpenedGroupMessageV2>
  /** Checks the entries without a reusable verdict with `concurrency` workers; every check of the handle (openVerified's
   *  too) shares its verifyConcurrency limit. Each list is in roster order. */
  verifyMembers(opts?: { verifyMember?: MemberVerifierV2 | 'trust-roster'; concurrency?: number }): Promise<{ verified: Address[]; mismatch: Address[]; failed: Array<{ container: Address; error: { code: string; message: string } }> }>
}
/** @experimental The owner's format-2 handle. */
export interface OwnerGroupV2 extends Omit<OwnerGroup, 'format' | 'roster' | 'members' | 'acceptEpoch' | 'open' | 'snapshot'> {
  readonly format: 2
  snapshot(): GroupSnapshotV2
  readonly roster: RosterV2 | null
  readonly members: RosterMemberV2[]
  acceptEpoch: GroupHandleV2['acceptEpoch']
  open: GroupHandleV2['open']
  openVerified: GroupHandleV2['openVerified']
  verifyMembers: GroupHandleV2['verifyMembers']
}
/** @experimental A verifier for both formats: compares ed25519, and x25519 when the entry has one, with api.chain.channelKeys. */
export declare function channelKeysVerifier(api: { chainId?: number; chain: { channelKeys(container: string, opts?: { fresh?: boolean }): Promise<{ x25519: string; ed25519: string }> } }): MemberVerifierV2
