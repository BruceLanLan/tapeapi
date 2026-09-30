// TAPI-27 delivery in one call (sdk/src/group-delivery.js). A group uses TWO kinds of room: the group room
// (group.room) for epoch messages, and each member's inbox room (channel.inboxRoom(container, chainId)) for its
// invite. deliverGroupUpdate posts both; checkGroupInvites reads the member's inbox. See docs/guides/groups.md.
import type { Address, TxRequest } from './common.js'
import type { Identity } from './channel.js'
import type { Group, OwnerGroup } from './group.js'
import type { TapeAPI, ResolvedService, Payer } from './index.js'

/** The error code of every failure in this module. */
export declare const DELIVERY_ERROR: 'GROUP_DELIVERY'

/** A relay to post to or read from: a TapeAPI client and the resolved relay service (e.g. api.resolve('12.1013.tape')). */
export interface RelayCarrier {
  api: Pick<TapeAPI, 'call'> & Partial<Pick<TapeAPI, 'chain' | 'chainId'>>
  /** The resolved relay service. Renamed from `svc` in 1.0. */
  service: ResolvedService
  /** @experimental For a priced relay: the payment channel relaySend is paid from (TAPI-22). */
  payer?: Payer
}
/**
 * A ChannelBus to post to. The SDK holds no wallet: sendTx sends the transaction and returns its hash.
 * (`bus` elsewhere in the SDK: in busTransport / busReader / busPrivacyReader it is the ChannelBus contract ADDRESS; in
 * createInvite / createGroup and a channel record's `inbox.bus` it is the TAPI-26 bus DESCRIPTOR. Here it is a carrier.)
 */
export interface BusCarrier {
  address: Address
  sendTx: (tx: TxRequest) => Promise<string> | string
}

/** One post: an invite to a member's inbox room, or the epoch message to the group room. */
export interface GroupDelivery {
  what: 'invite' | 'epoch'
  /** The room it went to: the member's inbox room for an invite, group.room for the epoch message. */
  room: string
  /** Invites only: the member's container and chainId the inbox room was derived from. */
  container?: Address
  chainId?: number
  via: 'relay' | 'bus' | null
  relay?: string
  bus?: string
  ok: boolean
  /** Relay only: the frame's index in the room and the ROOM's epoch (not the group's), as relaySend answered. */
  i?: number
  epoch?: string | null
  /** Bus only: what sendTx returned. */
  txHash?: string
  error?: { code: string; message: string; rateLimited?: boolean; retryAfterS?: number }
}
export interface GroupDeliveryResult {
  ok: boolean
  groupEpoch: number
  /** The group room. */
  room: string
  deliveries: GroupDelivery[]
}

/**
 * Owner: post the invites to each member's INBOX room, then the epoch message to the GROUP room, over every relay and
 * bus given, and report every post. `update` is what createGroup / addMembers / removeMembers / rotate / resumeGroup
 * returned (omit it to repost group.epochWire). `invite`: 'new' (default: update.added), 'all', 'none' or a list of
 * roster members. Any failed post throws TapeAPIError('GROUP_DELIVERY') after all were tried, with
 * `data: GroupDeliveryResult`; with throwOnError: false the result says ok: false instead.
 */
export declare function deliverGroupUpdate(opts: {
  group: OwnerGroup
  /** What createGroup / addMembers / removeMembers / rotate / resumeGroup returned (a GroupUpdate, or any object with its epochWire and added). */
  update?: { epochWire: Uint8Array; added?: ReadonlyArray<{ container: Address; chainId?: number }> }
  invite?: 'new' | 'all' | 'none' | Array<Address | { container: Address; chainId?: number }>
  /** Relay clients to post through (always a list). Not `relays`, which is a roster's list of { url, container }
   *  (createGroup); `relays`, `relay`, `buses` and `bus` are refused with INVALID_ARGUMENT. */
  relayClients?: RelayCarrier[]
  /** ChannelBus contracts to post to (always a list). */
  busClients?: BusCarrier[]
  throwOnError?: boolean
  random?: (n: number) => Uint8Array
}): Promise<GroupDeliveryResult>

/** Where cursors are kept: a Map works; back it with a file or database to survive restarts. Sync or async. */
export interface CursorStore {
  get(key: string): unknown
  set(key: string, value: { after: number; epoch: string | null }): unknown
}
export interface GroupInviteCheck {
  /** false when some relay could not be read (listed in `failed`); when none could, the call throws. */
  ok: boolean
  /** The inbox room read: compare it with the `room` of the owner's invite delivery when nothing arrives. */
  room: string
  container: Address
  chainId: number
  invites: Array<{ invite: Record<string, any>; i: number; relay: string }>
  skipped: number
  skippedBy: { unreadable: number; channelInvite: number; otherKind: number; notSealed: number }
  failed: Array<{ relay: string; error: { code: string; message: string } }>
}

/**
 * Member: read this container's inbox room (channel.inboxRoom(self.container, self.chainId)) on each relay and open
 * the group invites. `self.container` must be the CONTAINER address, not the holder's wallet. The cursor of each room
 * is kept in `cursors` with the relay's room epoch; the first read uses after: -1, epoch: null.
 */
export declare function checkGroupInvites(opts: {
  self: { container: Address; chainId?: number; staticSecret?: Uint8Array }
  identity?: Identity
  /** Relay clients to read (always a list; `relays` and `relay` are refused). */
  relayClients: RelayCarrier[]
  cursors?: CursorStore
  waitMs?: number
  /** The holder's wallet, if known: the call is refused when it equals self.container. */
  holder?: Address
  /** true (use relayClients[0].api) or a TapeAPI client: check the container's channel record publishes this identity. */
  checkSelf?: boolean | Pick<TapeAPI, 'chain' | 'chainId'>
}): Promise<GroupInviteCheck>
