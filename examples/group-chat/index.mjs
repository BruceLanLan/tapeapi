#!/usr/bin/env node
// A minimal TAP-27 group chat over the public relay (12.1013.tape): two throwaway identities, an owner and a member,
// each with its own TapeAPI client. The owner creates the group and delivers the epoch message AND the invite in one
// call (deliverGroupUpdate); the member finds the invite in its inbox room (checkGroupInvites), joins, and the two
// exchange one message each.
//
//   node examples/group-chat/index.mjs
//
// DEMO ONLY: the containers are random addresses and the identities have no channel record on chain, so members are
// taken on trust (verifyMember: 'trust-roster') and the member takes the owner's keys from the owner directly. A real
// application checks every member with api.groupVerifier() and looks the owner up with
// api.chain.channelKeys(invite.owner.container). See docs/guides/groups.md.
//
// 公共中继（12.1013.tape）上的最小 TAP-27 群聊：两个临时身份（群主与成员），各用自己的 TapeAPI 客户端。群主建群，一次调用
// 投递纪元消息**和**邀请（deliverGroupUpdate）；成员在收件房间里找到邀请（checkGroupInvites），入群，双方各发一条消息。
// **仅供演示**：容器是随机地址，身份在链上没有通道记录，所以成员靠信任（verifyMember: 'trust-roster'），成员直接从群主处拿到
// 群主公钥。正式应用必须用 api.groupVerifier() 核验每个成员，并用 api.chain.channelKeys(invite.owner.container) 查群主。
import { createTapeAPI, rpcUrlsFor, channel, group as G, deliverGroupUpdate, checkGroupInvites } from '@tapeapi/sdk'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'

export const PUBLIC_RELAY = '12.1013.tape'
export const PUBLIC_RELAY_URL = 'https://relay.tapeapi.fun/tapeapi/v1'

const hex = (b) => '0x' + Buffer.from(b).toString('hex')
const short = (h) => `${h.slice(0, 10)}…`

// A throwaway container address and channel identity. In a real app: the container of the user's circuit, and the
// identity whose public keys its holder published (scripts/channel-keys.mjs, api.tx.publishChannelKeys).
// 临时的容器地址与通道身份。正式应用中：用户电路的容器，以及持有人已发布公钥的那个身份。
function throwaway(chainId = 56) {
  const identity = channel.generateIdentity()
  const container = hex(randomBytes(20))
  return { self: { container, chainId }, identity, keys: { container, chainId, x25519: hex(identity.x25519.publicKey), ed25519: hex(identity.ed25519.publicKey) } }
}

/**
 * The whole flow. `owner` and `member` are { api, svc } for the same relay seen by two independent clients.
 * 完整流程。`owner` 与 `member` 是两个独立客户端各自看到的同一个中继 { api, svc }。
 */
export async function runGroupChat({ owner: ownerRelay, member: memberRelay, relayUrl = PUBLIC_RELAY_URL, log = console.log, waitMs = 5_000 }) {
  const alice = throwaway(), bob = throwaway()
  log(`owner  (Alice) container ${alice.self.container}`)
  log(`member (Bob)   container ${bob.self.container}`)

  // 1. Owner: create the group and deliver it. The epoch message goes to the GROUP room, the invite to Bob's INBOX room.
  //    群主：建群并投递。纪元消息去群房间，邀请去 Bob 的收件房间。
  const created = await G.createGroup({
    self: alice.self, identity: alice.identity, members: [bob.keys],
    relays: [{ url: relayUrl, container: ownerRelay.svc.container }],
    verifyMember: 'trust-roster',   // DEMO ONLY: a real app passes api.groupVerifier() / 仅演示；正式应用用 api.groupVerifier()
  })
  const owner = created.group
  const sent = await deliverGroupUpdate({ group: owner, update: created, relay: ownerRelay })   // throws if any post fails / 任何一条失败都会抛出
  for (const d of sent.deliveries) log(`posted ${d.what.padEnd(6)} to room ${short(d.room)} ${d.what === 'invite' ? `(inbox of ${short(d.container)})` : '(group room)'}: i=${d.i}`)

  // 2. Member: check the inbox. The cursor store (here a Map) keeps { after, epoch } per room between checks.
  //    成员：检查收件房间。游标存储（这里是 Map）按房间保存 { after, epoch }。
  const cursors = new Map()
  let found
  for (let tries = 0; tries < 5; tries++) {
    found = await checkGroupInvites({ self: bob.self, identity: bob.identity, relay: memberRelay, cursors, waitMs })
    if (found.invites.length) break
  }
  if (!found.invites.length) throw new Error(`no invite in inbox room ${found.room}; the owner posted to ${sent.deliveries[0].room}`)
  const { invite } = found.invites[0]
  log(`Bob found the invite to group ${invite.gid} in room ${short(found.room)} (skipped ${found.skipped} other frames)`)

  // 3. Member: join. The owner's keys come from the chain in a real app (api.chain.channelKeys(invite.owner.container)).
  //    成员：入群。正式应用中群主公钥来自链上。
  const bobGroup = G.joinGroup({ self: bob.self, identity: bob.identity, invite, ownerKeys: alice.keys /* DEMO ONLY / 仅演示 */ })
  const bobLink = channel.relayTransport({ api: memberRelay.api, svc: memberRelay.svc, inbound: bobGroup.room, outbound: bobGroup.room, waitMs })
  const aliceLink = channel.relayTransport({ api: ownerRelay.api, svc: ownerRelay.svc, inbound: owner.room, outbound: owner.room, waitMs })
  for (let tries = 0; bobGroup.epoch === null && tries < 5; tries++) {
    for (const w of await bobLink.poll()) {
      const t = channel.decodeWire(w)
      if (t.groupEpoch) await bobGroup.acceptEpoch(t.groupEpoch, { verifyMember: 'trust-roster' /* DEMO ONLY / 仅演示 */ }).catch((e) => log(`  (skipped an epoch message: ${e.message})`))
    }
  }
  if (bobGroup.epoch === null) throw new Error('Bob never saw the epoch message in the group room')
  log(`Bob joined at epoch ${bobGroup.epoch}; members: ${bobGroup.members.length}`)

  // 4. One message each way / 双方各发一条
  await bobLink.send(bobGroup.seal('hi Alice, Bob here'))
  await aliceLink.send(owner.seal('welcome, Bob'))
  const heard = { alice: [], bob: [] }
  for (let tries = 0; tries < 5 && !(heard.alice.length && heard.bob.length); tries++) {
    for (const [who, g, link] of [['alice', owner, aliceLink], ['bob', bobGroup, bobLink]]) {
      for (const w of await link.poll(heard[who].length ? 0 : waitMs)) {
        const t = channel.decodeWire(w)
        if (!t.groupMessage) continue
        const m = g.open(t.groupMessage, { text: true })
        if (!m.own) heard[who].push(m.data)
      }
    }
  }
  log(`Alice read: ${JSON.stringify(heard.alice)}`)
  log(`Bob read:   ${JSON.stringify(heard.bob)}`)
  return { gid: owner.gid, deliveries: sent.deliveries, invite, heard, inboxRoom: found.room, groupRoom: owner.room }
}

// Two independent clients, each resolving the public relay from the chain and checking every answer's signature.
// 两个独立客户端，各自从链上解析公共中继，并核验每个回答的签名。
async function main() {
  const client = async () => {
    const api = createTapeAPI({ rpcUrls: rpcUrlsFor(56), quorum: 2 })
    return { api, svc: await api.resolve(PUBLIC_RELAY) }
  }
  const [owner, member] = await Promise.all([client(), client()])
  const r = await runGroupChat({ owner, member })
  if (!r.heard.alice.length || !r.heard.bob.length) { console.error('a message did not arrive'); process.exit(1) }
  console.log('done: the relay only ever held ciphertext; its rooms are forgotten after 15 idle minutes.')
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => { console.error(e.code ? `${e.code}: ${e.message}` : e); process.exit(1) })
}
