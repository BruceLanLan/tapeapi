// @tapeapi/sdk/channel: the public face of the TAP-26 channel module (review G1 M3, M5, M9).
// channel.js holds the implementation and exports more than the public API (test hooks, generic byte helpers); the
// package's `exports` map points `@tapeapi/sdk/channel`, and the root export `channel`, at this file, so only the names
// below are importable from outside the package.
//   - not exported: toHex / fromHex (bare hex without 0x, unlike abi.toHex), toBase64 / fromBase64 (generic helpers),
//     and the test hooks _keySchedule, _busMerge, _busKindOf.
//   - relayTransport takes `service` (the resolved relay service), like every other 1.0 option.
// @tapeapi/sdk/channel：TAP-26 通道模块的公开接口。channel.js 是实现，导出的名字多于公开接口（测试钩子、通用字节工具）；
// 包的 exports 把 `@tapeapi/sdk/channel` 与根导出的 `channel` 指向本文件，包外只能引用下面这些名字。
import { TapeAPIError } from './errors.js'
import * as core from './channel.js'

export {
  CHANNELBUS_MAX_BATCH, CHANNELBUS_MAX_WIRE, CHANNELBUS_WIRE_TOPIC, DEFAULT_INVITE_TTL_S, INVITE_KIND, KEYS_CHANNEL, KEYS_TAPESEND,
  MAX_FRAME_BYTES, MAX_INVITE_TTL_S, MAX_SEQ, VERDICT_MS,
  acceptInvite, assertEd25519Public, assertPublicKey, assertUsablePublicKey, busReader, busTransport, checkBus, checkRelays,
  completeInvite, createInvite, decodeInviteContent, decodeWire, encodeInviteContent, encodeWire, endpointBytes, fanIn,
  generateIdentity, generateKeyPair, inboxRoom, inviteHash, openFromInbox, openInvite, publicKeyOf, roomsFor, sealInvite,
  sealToInbox,
} from './channel.js'

/**
 * A transport over a TAP-26 relay service. `service` is the resolved relay (await api.resolve('12.1013.tape')); `payer`
 * pays a priced relay (experimental). / 经 TAP-26 中继服务的传输；`service` 是已解析的中继服务。
 */
export function relayTransport(opts = {}) {
  if (opts && Object.prototype.hasOwnProperty.call(opts, 'svc')) {
    throw new TapeAPIError('INVALID_ARGUMENT', 'relayTransport takes { service }: the option `svc` was renamed in 1.0 (docs/guides/upgrade-1.0.md)')
  }
  const { service, ...rest } = opts ?? {}
  if (!service || typeof service !== 'object') throw new TapeAPIError('INVALID_ARGUMENT', 'relayTransport needs { api, service }: service is the resolved relay (await api.resolve(...))')
  return core.relayTransport({ ...rest, svc: service })
}
