[English](../groups.md) | 中文

# 群聊

本指南面向已经接入 TapeAPI 的应用，讲怎样加上私密群聊（[TAP-27](../../../spec/TAP-27.md)）。一个群至多 32 个
TapeOut 容器，其中一个是**群主**，负责维护成员名单。消息端到端加密并签名；承载它们的中继或 ChannelBus 只看得到密文。

可以直接从示例起步：[`examples/group-chat/`](../../../examples/group-chat/)（`node examples/group-chat/index.mjs`，走公共中继）。

## 开始之前

每个成员（包括群主）都需要：

- **一枚电路和它的容器。** 容器是电路的 ERC-6551 账户，群里用这个地址认人。它**不是**持有电路的钱包。
- **已发布的通道身份。** 一把用于邀请的 X25519 密钥和一把用于签名的 Ed25519 密钥，由应用生成、持有人钱包授权、发布在容器
  站点上：用 `scripts/channel-keys.mjs`（见[私密通道](channels.md)）或 `api.tx.publishChannelKeys({ container, record })`。
  保存好含私钥的身份文件；发布出去的记录里只有公钥。
- **一种传输。** 免费的公共中继 `12.1013.tape`（见[公共 API](public-api.md)）、你自己的中继，或 ChannelBus。

用 `await api.chain.channelKeys(container)` 检查成员：只有电路的**当前**持有人授权过的密钥才会返回。

## 两个房间：最容易出错的地方

群用到两种房间，新成员两个都需要：

| 房间 | 房间号 | 放什么 | 谁读 |
|---|---|---|---|
| **群房间** | `group.room` | 纪元消息（群密钥与加密的成员名单）和群消息 | 所有成员 |
| **收件房间** | `channel.inboxRoom(container, chainId)`，每个成员一个 | 密封邀请，告诉新成员这个群存在 | 该成员自己 |

`createGroup` 和 `addMembers` 只返回纪元消息（`epochWire`），它要发到群房间。新成员此时还不知道群房间：它要从邀请里得知，
而邀请必须由群主用 `group.inviteFor(member)` 生成，再投到**该成员的收件房间**。只发纪元消息，新成员就会一直等下去；
中继本身没问题，只是成员读的那个房间里什么也没有。

`deliverGroupUpdate` 一次把两件事都做了。请直接用它。

## 群主

```js
import { createTapeAPI, rpcUrlsFor, group as G, deliverGroupUpdate } from '@tapeapi/sdk'

const api = createTapeAPI({ rpcUrls: rpcUrlsFor(56), quorum: 2 })
const relay = { api, service: await api.resolve('12.1013.tape') }
const verifyMember = api.groupVerifier()                 // 按通道记录核验每个成员

// 其他成员按链上发布的样子取来：用容器地址，绝不用钱包
const members = await Promise.all([bobContainer, carolContainer].map((c) => api.chain.channelKeys(c)))

const created = await G.createGroup({
  self: { container: myContainer, chainId: 56 }, identity: myIdentity, members, verifyMember,
  relays: [{ url: 'https://relay.tapeapi.fun/tapeapi/v1', container: relay.service.container }],
})
const group = created.group
const sent = await deliverGroupUpdate({ group, update: created, relayClients: [relay] })
// sent.deliveries：每次投递一条，先邀请、后纪元消息：
//   { what: 'invite', room, container, chainId, via: 'relay', ok: true, i: 0, epoch: '<房间纪元>' }
//   { what: 'epoch',  room: group.room, via: 'relay', ok: true, i: 0, epoch: '<房间纪元>' }
```

成员变动返回同样的更新，`added` 说明谁是新成员：

```js
const up = await group.addMembers([await api.chain.channelKeys(daveContainer)], { verifyMember })
up.added                                                 // [{ container, chainId, x25519, ed25519 }]：默认给他们发邀请
await deliverGroupUpdate({ group, update: up, relayClients: [relay] })

await deliverGroupUpdate({ group, update: await group.removeMembers([carolContainer]), relayClients: [relay] })   // 不发邀请
await deliverGroupUpdate({ group, update: await group.rotate(), relayClients: [relay] })                          // 至少每 30 天一次
```

`deliverGroupUpdate` 做什么、返回什么：

- **顺序。** 先把邀请投到各成员的收件房间，再把纪元消息投到群房间（TAP-27 §3.5）。
- **邀请谁。** `invite: 'new'`（默认，即 `update.added`）、`'all'`（除群主外的所有成员）、`'none'`，或一组必须在当前名单里的
  容器地址。邀请一律用名单里（群主签过的）容器地址与 chainId。
- **多种传输。** `relayClients` 与 `busClients` 都是列表，每条都投到两者的每一项上。每份邀请只密封一次，所以同时读两个传输的成员
  看到的是同一份邀请两次，而不是两份邀请。
- **失败。** 每条都会尝试。只要有一条失败，调用随后抛出 `TapeAPIError('GROUP_DELIVERY')`：消息里写明第一个失败的房间，
  `data` 里有每条投递的结果；传 `throwOnError: false` 则改为返回 `{ ok: false, deliveries }`。绝不吞掉错误。
- **重发。** 不传 `update` 时重发当前纪元消息（`group.epochWire`）。TAP-27 §3.5 建议：房间寿命 15 分钟的中继上每 10 分钟
  重发一次，经公共节点读取的 ChannelBus 上每 30 分钟一次：

```js
setInterval(() => deliverGroupUpdate({ group, relayClients: [relay] }).catch(report), 10 * 60_000)
```

## 成员

```js
import { createTapeAPI, rpcUrlsFor, channel, group as G, checkGroupInvites } from '@tapeapi/sdk'

const api = createTapeAPI({ rpcUrls: rpcUrlsFor(56), quorum: 2 })
const relay = { api, service: await api.resolve('12.1013.tape') }
const self = { container: myContainer, chainId: 56 }    // 容器地址，以及它所在链的 chainId
const cursors = new Map()                                // 或你自己的存储，见"保存状态"

const found = await checkGroupInvites({ self, identity: myIdentity, relayClients: [relay], cursors, waitMs: 20_000, checkSelf: true })
for (const { invite } of found.invites) {
  const ownerKeys = await api.chain.channelKeys(invite.owner.container)   // 从链上查，绝不取自邀请
  const g = G.joinGroup({ self, identity: myIdentity, invite, ownerKeys })
  let greeted = false
  const link = channel.relayTransport({ api, service: relay.service, inbound: g.room, outbound: g.room })
  link.start(async (wire) => {
    const t = channel.decodeWire(wire)
    if (t.groupEpoch) {
      await g.acceptEpoch(t.groupEpoch, { verifyMember: api.groupVerifier() })
      if (!greeted && g.epoch !== null) { greeted = true; await link.send(g.seal('hello')) }   // 接受第一个纪元之后才能发送
    }
    if (t.groupMessage) { const m = g.open(t.groupMessage, { text: true }); if (!m.own) show(m.from, m.data) }
  }, { onError: report })
}
```

- `checkGroupInvites` 在每个中继上读取 `channel.inboxRoom(self.container, self.chainId)`，按中继和房间各存一个带房间纪元的
  游标（首次读取是 `after: -1, epoch: null`），返回 `{ room, invites, skipped, skippedBy, failed }`。不是发给本容器的
  群邀请的帧会被跳过并计数；同一收件房间里的 TAP-26 通道邀请计为 `channelInvite`，留给你的通道代码处理。
- `checkSelf: true` 先读取容器的通道记录，只有记录在这个 chainId 上发布了本身份的 X25519 公钥才继续：钱包地址、错的 chainId、
  过期的身份文件会立刻报错，而不是表现为一个空的收件房间。传入 `holder`（钱包地址），二者混用会被直接拒绝，不需要读链。
- 读不了的中继列在 `failed` 里（`ok` 为 false）；所有中继都读不了时，调用抛出错误。
- 邀请只说明"去哪里看"。成员只接受群主签名的纪元消息；接受第一条之后，改用名单里（群主签过的）中继与总线
  （`g.roster.relays`、`g.roster.bus`）。
- 新成员还会在群房间里看到更早的纪元消息。它们打不开（里面没有它的密钥），`acceptEpoch` 会拒绝（"not a member of it"），
  这是正常的，捕获后继续即可。

## 选中继还是 ChannelBus

| | 中继 | ChannelBus |
|---|---|---|
| 延迟与费用 | 约一个往返；公共中继免费 | 出块时间；每次投递是一笔交易，付 gas |
| 保留什么 | 房间（密文）保留到最后一次访问后 15 分钟，然后清除；公共中继存在 Durable Object 存储里，闲置房间不会因 Cloudflare 回收实例而丢失 | 链上事件，永久公开 |
| 限制 | 邀请与纪元消息：参考中继上每个来源每个房间每 10 分钟 8 条 | 每次投递至多 16,448 字节 |
| 群主 | `relayClients: [{ api, service, payer? }]` | `busClients: [{ address: MAINNET.channelBus, sendTx }]`：由你的钱包发送，每个房间一笔交易 |
| 成员 | `checkGroupInvites({ relayClients })`、`channel.relayTransport` | 在 `channel.inboxRoom(...)` 与 `group.room` 上用 `busPrivacy.busPrivacyReader`（默认按合约全量读取，见[读取隐私](channels.md#5-读取隐私)）或 `channel.busReader` |

群比较重要时，在 `createGroup({ relays, bus })` 里两者都写上，并在两者上都投递：成员读哪个都行。

## 保存状态与重启

**安全性**不依赖任何保存的状态；下面这些让重启**顺畅**：

- **群主：** 保存 `group.snapshot()`（不含秘密：名单与纪元号）。重启后 `G.resumeGroup({ self, identity, snapshot, verifyMember })`
  立即开启下一纪元（旧密钥已不在），并把它作为一次更新返回：`deliverGroupUpdate({ group: resumed.group, update: resumed, relayClients: [relay] })`。
  恢复出的句柄没有上一纪元的密钥：群主离线期间成员在那个纪元下发的消息会被拒收，错误为 `no key for epoch N (not in this handle's snapshot ...)`，
  且 `e.data.reason === 'snapshot'`，而不是被当作伪造。格式 2 的快照写为 `v: 2`（1.2.0 写的是 `v: 1`，仍可读取）：1.2.0 及更早的
  SDK 会拒收它，而不是把群当作格式 1 恢复，所以群主不能退回到这些版本。
- **成员：** 在 seal 之后保存 `g.snapshot()`。重启后把 `minEpoch: snapshot.epoch` 与 `lastSeq: snapshot.lastSeq` 传给
  `joinGroup`：中继重放旧纪元会被拒绝，时钟回拨也不会让新消息看起来像重放。它还让重启后的句柄知道：从房间里读回的
  自己以前的消息是自己的，而不是另一台设备的（见下文）。
- **游标：** `cursors` 接受任何 `{ get(key), set(key, value) }`，同步异步都行；可以存进文件或数据库。键是
  `relay:<中继容器>:<房间号>`，值是 `{ after, epoch }`。序号要和房间纪元一起存：只有序号没有纪元，正是下面排查清单里的那个错误。
- **身份：** 含私钥的身份文件。丢了它，成员只能发布新身份，并由群主重新加入。

## 聊天应用要处理的错误

`open()` 以 `GROUP_INVALID` 拒收；其中三种拒收是正常事件，用 `e.data` 区分：

- **消息先于它的纪元消息到达**（`e.data.reason === 'not-yet'`，`e.data.retryAfterEpoch: N`）。使用多个中继、或中继加
  ChannelBus 时，成员的消息可能先于群主那条生成其密钥的纪元消息到达。把它留下，`acceptEpoch` 之后再打开一次。如果那条纪元消息
  被拒收（"not a member of it"），说明本成员已被移除，留下的消息可以丢弃。SDK 不替你缓冲；几行代码即可：

```js
const held = []                                          // 先于纪元消息到达的消息，至多 256 条
function openOrHold(wire) {
  try { return g.open(wire, { text: true }) }
  catch (e) { if (e.data?.retryAfterEpoch !== undefined && held.length < 256) { held.push(wire); return null } throw e }
}
// 每接受一条纪元消息之后
for (const w of held.splice(0)) {
  try { const m = openOrHold(w); if (m && !m.own) show(m.from, m.data) }
  catch { /* 丢弃：其纪元已过期，或本成员不在该纪元中 */ }
}
```

- **纪元已丢弃**（`e.data.reason === 'expired'`）：下一纪元到达后，上一纪元只保留 10 分钟；成员加入之前的消息一概打不开。
  显示为空洞即可，无法找回。
- **群主重启过**（`e.data.reason === 'snapshot'`，出现在 `resumeGroup` 得到的句柄上）：见"保存状态与重启"。

**一个身份对应一台设备。** 持有同一身份的两台设备（或两个进程）各自从自己的时钟起算序号，其他人会把序号较低那台设备的消息
当作 `seq ... already seen` 拒收（并带 `e.data.mayBeOtherDevice: true`）。SDK 不会掩盖这一点：用本身份签名、却不是本句柄
封装的消息，`open()` 会完整返回并带 `otherDevice: true`（而不是 `own`），`g.otherDevice` 变为 `{ count, epoch, seq }`。
请提示用户只用一台设备，或者给每台设备各自的容器与身份。不带 `lastSeq` 重启的句柄会把房间里自己以前的消息当作另一台设备的；
请传入快照里的 `lastSeq`。

## 常见坑排查清单

| 现象 | 原因 | 解决 |
|---|---|---|
| 群主建群成功，成员一直收不到邀请，中继返回 0 帧 | 只发了纪元消息（到群房间），邀请从没投到收件房间 | 用 `deliverGroupUpdate({ group, update, relayClients: [relay] })`，并确认 `deliveries` 里每个新成员都有一条 `invite` |
| 同上，但邀请确实投了 | 房间不对：收件房间是用持有人**钱包**地址而不是**容器**地址算的，或者 chainId 不对 | 对比群主投递结果里邀请的 `room` 与 `checkGroupInvites` 返回的 `room`。用容器地址和它所在链的 chainId；`checkSelf: true` 会直接指出错误 |
| 序号 0 的邀请始终读不到 | 读取时沿用了别的房间（群房间）的 `after` 游标，又没带 `epoch`，中继从 0 号之后开始给 | 每个房间单独存游标并带房间纪元，首次读取用 `after: -1, epoch: null`。`checkGroupInvites` 就是这样做的，并会忽略没有纪元的存储游标 |
| 邀请或纪元消息过一阵就不见了 | 中继在最后一次访问 15 分钟后清除房间（公共中继在 2026-09-29 之前：闲置十几秒就会丢失） | 每 10 分钟重发纪元消息（`deliverGroupUpdate({ group, relayClients: [relay] })`）；给还没入群的成员重发邀请（`invite: 'all'`）；成员手里的旧游标会因房间纪元变化而自动重置 |
| 投递报错 `too many invites / epoch messages from this source in this room` | 中继对 0x03 / 0x04 帧按来源按房间限流（参考中继每 10 分钟 8 条） | 等 `retryAfterS` 秒后重新投递，不要紧密循环重发。绝不能吞掉这个错误：`deliverGroupUpdate` 会抛出 `GROUP_DELIVERY`，`e.data.deliveries` 里失败的那一条带 `error.rateLimited: true` 与 `error.retryAfterS` |
| 签通道密钥时手机钱包回不到应用 | 应用跑在局域网 HTTP 地址上（`http://192.168.x.x`），钱包不会回连 | 用 HTTPS 隧道对外提供应用，并把 WalletConnect 的 `metadata.url` 设成与实际访问地址完全一致的 HTTPS 源 |
| 新成员对某些纪元消息报 "not a member of it" | 群房间里更早的纪元不是为它生成的 | 正常现象：捕获后继续；加入它的那个纪元能打开 |
| `no key for epoch N`，且带 `data.retryAfterEpoch` | 消息先于它的纪元消息到达（多个中继，或中继加 ChannelBus） | 留下它，`acceptEpoch` 之后再打开（见"聊天应用要处理的错误"） |
| 某个成员的消息被以 `already seen` 拒收，且带 `data.mayBeOtherDevice` | 同一身份在两台设备上发送；序号较低的那台被所有人拒收 | 一个身份只用一台设备；设备本身会在对方的消息上看到 `otherDevice: true`，并可查 `g.otherDevice` |
| 旧客户端收到格式 2 邀请后入群成功，随后每一帧都报 `GROUP_INVALID`（`data.format: 2`） | 该客户端早于格式 2：它一声不响地入群，之后拒收该群的帧 | 入群前检查 `invite.format === 2`，提示用户升级 |

## 格式 2（实验性）：入群之前，以及群主要读取什么

**入群前检查邀请的格式。** 不支持格式 2 的客户端（1.2 之前的所有 SDK）能打开格式 2 的邀请，`joinGroup` 也会一声不响地成功；
之后每一条纪元消息与群消息才以 `GROUP_INVALID`、`data.format: 2` 失败。请先检查，让用户看到"请升级"，而不是一个永远用不了的群：

```js
const inv = G.openGroupInvite(wire, { self })            // 或 found.invites[i].invite
// 1.2 之前的 SDK 里 G.MAX_MEMBERS_V2 为 undefined：这样的构建不能加入格式 2 的群
if (inv.format === 2 && !G.MAX_MEMBERS_V2) return askToUpdate(inv)
```

尚未采用格式 2 的应用，无论用哪个版本的 SDK，都用自己的开关做同样的检查。

**群主每个纪元要读取什么。** 群主对未变化的成员复用自己得出的肯定结论，至多 24 小时（`createGroup` / `resumeGroup` 的
`verifyReuseS`，默认 86,400 秒）。128 人时，移除一人或轮换**不读取**任何记录，加一人读取**一条**（新成员，只一次，绕过缓存），
结论过期后的第一个纪元读取全部 127 条：按默认并发 8，约 2,300 个 HTTP 请求、27 秒（BSC 上每条记录约 18 个请求、1.7 秒），
至多每天一次。SDK 1.2.0 每个纪元都这样全量读取，并且对新加入的成员读取两次。恢复出的群主没有任何结论，所以它的第一个纪元会读取
所有人。`verifyReuseS: 0` 回到每个纪元都读取全部成员，适合必须在下一个纪元、而不是一天之内移除已出售电路的群主（TAP-27 §8）。

## 局限

- 每个群至多 32 人。实验性的格式 2（TAP-27 §3.8，`createGroup({ format: 2 })`）在一条线路消息里最多容纳 128 人：名单改为
  二进制，成员核验改为按需进行。尚未核验的发送者发来的消息带 `verified: false`，界面上要标为"未核验"，或改用 `openVerified`。
  格式 2 的成员条目不含 X25519 公钥，所以请用 `group.channelKeysVerifier(api)` 核验，**不要**用 `api.groupVerifier()`：
  它比较两把公钥，会把每个成员都判为不符。核验一致的成员至多被信任 24 小时（`verifyReuseS`，从核验开始时起算）；核验不符的
  至多被拒收 60 秒，之后重新核验，而且这个"否"总是来自绕过客户端缓存的读取，落后节点找不到的记录不会让任何人长时间噤声。
  RPC 故障永远不是结论。格式 1 群的 `joinGroup` 会忽略 `verifyMember` 与 `verifyReuseS`，同时支持两种格式的代码可以对每份邀请都传入它们。
  格式 1 的客户端（1.2 之前的所有 SDK）遇到格式 2 的群会报 `GROUP_INVALID`；同一个群不能混用两种格式。超过约 64 人时请自己
  运行中继（公共中继只用于测试和小群）；100 人以上时，群主应放在常驻在线的主机或 Web Worker 里：在手机上为 128 人生成一个纪元
  需要数秒。
- 群主是单点：只有群主能加人、移除、换密钥，不支持转让群主。需要新群主的群就是一个新群。
- 元数据可见：中继看得到房间号、帧大小、时间，以及投递与轮询方的 IP；读群房间的人看得到成员人数与消息的大小和时间。
  在 ChannelBus 上这些全部永久公开。内容与成员名单保持加密。
- 被移除的成员保留它被移除之前能读到的一切。
- 未经第三方审计。
