// TAP-26 real-time private channels. Shapes are deliberately loose: see docs/guides/channels.md and spec/TAP-26.
import type { Address, TxRequest } from './common.js'
import type { Rpc } from './rpc.js'

export declare const INVITE_KIND: string
export declare const KEYS_CHANNEL: string
export declare const KEYS_TAPESEND: string
export declare const MAX_FRAME_BYTES: number
export declare const MAX_INVITE_TTL_S: number
export declare const DEFAULT_INVITE_TTL_S: number
export declare const MAX_SEQ: bigint
export declare const CHANNELBUS_WIRE_TOPIC: string
export declare const CHANNELBUS_MAX_WIRE: number
export declare const CHANNELBUS_MAX_BATCH: number
export declare const VERDICT_MS: number

export type RandomBytes = (n: number) => Uint8Array
export interface KeyPair { secretKey: Uint8Array; publicKey: Uint8Array }
export interface Identity { x25519: KeyPair; ed25519: KeyPair }

/** This side of a channel: the container it speaks for and its static X25519 secret. */
export interface ChannelSelf { container: Address; chainId?: number; staticSecret: Uint8Array; [key: string]: unknown }
/** The other side: its container and its published static X25519 public key (from chain.channelKeys). */
export interface ChannelPeer { container: Address; chainId?: number; staticPublic: Uint8Array | string; [key: string]: unknown }
export interface RelayRef { url: string; container?: Address }

export interface Invite {
  v: 1
  kind: string
  cid: string
  e: string
  exp: number
  from: { container: Address; chainId: number }
  keys: string
  relays: RelayRef[]
  bus?: unknown
  webrtc?: unknown
  [key: string]: unknown
}
export interface AcceptMessage { t: 'accept'; cid: string; e: string; confirm: string }
export interface ReadyMessage { t: 'ready'; cid: string; confirm: string }
/** Opaque initiator handle from createInvite; only the original object works in completeInvite. */
export interface PendingInvite { readonly role: 'initiator'; readonly cid: string; readonly exp: number }

/** An encrypted channel session (TAP-26 §3.4). */
export interface ChannelSession {
  readonly role: 'initiator' | 'responder'
  readonly cid: string
  readonly transcript: string
  readonly peer: { container: Address; chainId: number }
  readonly rooms: { inbound: string; outbound: string }
  readonly confirmed: boolean
  confirm(ready: ReadyMessage, opts?: { now?: number }): void
  seal(data: Uint8Array | string): Uint8Array
  open(frame: Uint8Array, opts?: { text?: boolean }): { seq: number; data: Uint8Array | string; skipped: number }
  close(): void
  [key: string]: unknown
}

/** A message transport (relay, ChannelBus, or fanIn over several). */
export interface Transport {
  send(wire: Uint8Array | AcceptMessage | ReadyMessage | unknown): Promise<unknown>
  poll?(): Promise<unknown>
  start(onWire: (wire: Uint8Array, meta?: Record<string, unknown>) => unknown, opts?: Record<string, unknown>): unknown
  stop?(): unknown
  [key: string]: unknown
}

export declare function createInvite(opts: {
  self: ChannelSelf
  peer: ChannelPeer
  relays?: RelayRef[]
  bus?: unknown
  keys?: string
  ttlS?: number
  webrtc?: unknown
  now?: number
  random?: RandomBytes
}): { invite: Invite; pending: PendingInvite }

export declare function acceptInvite(opts: {
  self: ChannelSelf
  peer: ChannelPeer
  invite: Invite
  now?: number
  random?: RandomBytes
  seen?: Set<string>
}): { accept: AcceptMessage; session: ChannelSession }

export declare function completeInvite(pending: PendingInvite, accept: AcceptMessage, opts?: { now?: number }): { ready: ReadyMessage; session: ChannelSession }

/** Relay transport over a TAP-26 relay service resolved with api.resolve (e.g. '12.1013.tape'). */
export declare function relayTransport(opts: {
  api: { call: (...args: any[]) => Promise<any>; [key: string]: unknown }
  svc: unknown
  payer?: unknown
  inbound: string
  outbound: string
  waitMs?: number
  retryMs?: number
}): Transport

export interface BusOptions {
  rpc: Rpc
  bus: Address
  fromBlock?: number
  lookback?: number
  confirmations?: number
  overlap?: number
  pollMs?: number
  chunk?: number
  minChunk?: number
  budgetMs?: number
  verdictMs?: number
  startGraceMs?: number
  blockBodyLimit?: number
  warn?: (...args: unknown[]) => void
}
/** ChannelBus (on-chain) transport. `sendTx` posts a TxRequest with your own wallet. */
export declare function busTransport(opts: BusOptions & {
  inbound: string
  outbound: string
  sendTx?: (tx: TxRequest) => Promise<unknown>
}): Transport
/** Read-only ChannelBus reader for many rooms. */
export declare function busReader(opts?: Partial<BusOptions> & { rooms?: string[] }): {
  add(room: string, handler?: (wire: Uint8Array, meta?: Record<string, unknown>) => unknown, opts?: { fromBlock?: number }): unknown
  remove(room: string): unknown
  poll(): Promise<Array<{ room: string; wire: Uint8Array }>>
  start(onWire?: (wire: Uint8Array, meta: { room: string }) => unknown, opts?: { onError?: (e: unknown) => void }): unknown
  stop(): unknown
  [key: string]: unknown
}
/** Merge several transports, dropping duplicate wire messages. */
export declare function fanIn(transports: Transport[], opts?: { all?: boolean; window?: number }): Transport

export declare function generateKeyPair(random?: RandomBytes): KeyPair
export declare function generateIdentity(random?: RandomBytes): Identity
export declare function publicKeyOf(secretKey: Uint8Array): Uint8Array
export declare function roomsFor(cid: Uint8Array | string): { toInitiator: string; toResponder: string }
export declare function inboxRoom(container: Address, chainId?: number): string
export declare function endpointBytes(container: Address, chainId?: number): Uint8Array
export declare function inviteHash(invite: Invite): Uint8Array
export declare function encodeInviteContent(invite: Invite): Uint8Array
export declare function decodeInviteContent(bytes: Uint8Array): Invite
export declare function sealInvite(invite: Invite, opts: { to: Uint8Array | string; random?: RandomBytes }): Uint8Array
export declare function sealToInbox(content: unknown, opts: { to: Uint8Array | string; random?: RandomBytes }): Uint8Array
export declare function openInvite(wire: Uint8Array, opts: { self: unknown }): Invite
export declare function openFromInbox(wire: Uint8Array, opts: { self: unknown }): any
export declare function encodeWire(x: Uint8Array | AcceptMessage | ReadyMessage): Uint8Array
export declare function decodeWire(b: Uint8Array): { frame?: Uint8Array; sealedInvite?: Uint8Array; handshake?: AcceptMessage | ReadyMessage; [key: string]: unknown }
export declare function checkRelays(relays: RelayRef[]): void
export declare function checkBus(bus: unknown): void
export declare function assertPublicKey(pk: Uint8Array, name?: string): Uint8Array
export declare function assertUsablePublicKey(pk: Uint8Array, name?: string): Uint8Array
export declare function assertEd25519Public(pub: Uint8Array | string, name?: string): Uint8Array
export declare function toHex(bytes: Uint8Array): string
export declare function fromHex(h: string, len?: number, name?: string): Uint8Array
export declare function toBase64(bytes: Uint8Array): string
export declare function fromBase64(s: string): Uint8Array
/** @internal exported for tests */
export declare function _keySchedule(input: Record<string, unknown>): any
/** @internal exported for tests */
export declare function _busMerge(nodes: unknown, lo: number, hi: number): any
/** @internal exported for tests */
export declare function _busKindOf(error: unknown): any
