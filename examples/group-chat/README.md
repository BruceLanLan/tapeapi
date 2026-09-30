# group-chat — 最小群聊（TAP-27）

**给谁**：要在自己的应用里加群聊的开发者。
**做什么**：用公共中继 `12.1013.tape` 走完一次群聊：两个临时身份（群主 Alice、成员 Bob），各用自己的 TapeAPI 客户端。

1. Alice 建群，用 `deliverGroupUpdate` **一次**投递两样东西：邀请投到 Bob 的**收件房间**，纪元消息投到**群房间**；
2. Bob 用 `checkGroupInvites` 检查自己的收件房间，找到邀请；
3. Bob 入群（`joinGroup`），从群房间读到纪元消息；
4. 双方各发一条消息，各自读到对方的那条。

```bash
npm install --no-audit --no-fund   # 在 tapeapi/ 根目录执行一次
node examples/group-chat/index.mjs
```

输出里能看到每条投递的房间号和中继返回的序号 `i`，以及成员读取的房间号：两边的收件房间号一致，邀请才能送达。

## 演示与正式应用的区别

**演示用的临时身份不需要链上记录。** 容器是随机地址，通道密钥没有发布到链上，所以演示里：

- 群主用 `verifyMember: 'trust-roster'` 接受成员，不做核验；
- 成员直接拿群主的公钥（`ownerKeys: alice.keys`）。

**正式应用必须**：

- 每个成员都有电路、容器，并已发布通道身份（`scripts/channel-keys.mjs` 或 `api.tx.publishChannelKeys`）；
- 群主用 `verifyMember: api.groupVerifier()`，按链上通道记录核验每个成员；
- 成员用 `api.chain.channelKeys(invite.owner.container)` 从链上查群主公钥，绝不取自邀请；
- 成员地址一律用**容器地址**（ERC-6551 账户），不是持有人钱包。

完整流程、传输选择、状态保存与排查清单见 [群聊接入指南](../../docs/guides/zh-CN/groups.md)。

## 文件

| 文件 | 内容 |
|---|---|
| `index.mjs` | 演示本身；`runGroupChat({ owner, member })` 也可以接任何中继 |
| `group-chat.test.mjs` | 端到端测试：本机起一个经过验证的中继服务，两个独立客户端跑完同一流程（`npm test` 会跑） |

## 限制

- 中继是尽力而为的公共服务：房间保留到最后一次访问后 15 分钟就被清除（公共中继存在 Durable Object 存储里，存的是密文）；邀请与纪元消息按来源按房间限流。
- 中继看得到房间号、帧大小与时间，看不到内容与成员名单。
- 至多 32 人（实验性的格式 2 最多 128 人，见 [群聊指南](../../docs/guides/zh-CN/groups.md)）；群主是单点；未经第三方审计。

---

# group-chat — a minimal group chat (TAP-27)

**For**: developers adding group chat to their application.
**What it does**: one group chat over the public relay `12.1013.tape`, with two throwaway identities (Alice the owner,
Bob the member), each on its own TapeAPI client.

1. Alice creates the group and delivers two things in **one** call, `deliverGroupUpdate`: the invite to Bob's **inbox
   room** and the epoch message to the **group room**;
2. Bob checks his inbox room with `checkGroupInvites` and finds the invite;
3. Bob joins (`joinGroup`) and reads the epoch message from the group room;
4. each sends one message and reads the other's.

```bash
npm install --no-audit --no-fund   # once, from the tapeapi/ root
node examples/group-chat/index.mjs
```

The output shows the room of every post with the index `i` the relay returned, and the room the member read: the
invite arrives only when the two inbox room ids are the same.

## The demo versus a real application

**The demo's throwaway identities need no record on chain.** The containers are random addresses and no channel keys
are published, so in the demo:

- the owner accepts members with `verifyMember: 'trust-roster'`, without checking them;
- the member takes the owner's keys directly (`ownerKeys: alice.keys`).

**A real application must**:

- give every member a circuit, a container and a published channel identity (`scripts/channel-keys.mjs` or
  `api.tx.publishChannelKeys`);
- have the owner check every member against its channel record with `verifyMember: api.groupVerifier()`;
- have the member look the owner up on chain with `api.chain.channelKeys(invite.owner.container)`, never from the invite;
- use the **container address** (the ERC-6551 account) for every member, never the holder's wallet.

The full flow, choosing a transport, saving state and a troubleshooting checklist are in the
[groups guide](../../docs/guides/groups.md).

## Files

| File | What |
|---|---|
| `index.mjs` | the demo; `runGroupChat({ owner, member })` also works with any relay |
| `group-chat.test.mjs` | end-to-end test: a verified relay service on localhost and two independent clients running the same flow (run by `npm test`) |

## Limits

- The relay is a best-effort public service: rooms are cleared 15 minutes after the last access (the public relay
  keeps them, as ciphertext, in Durable Object storage until then); invites and epoch messages are limited per source
  per room.
- The relay sees room ids, frame sizes and timing, not content or the member list.
- At most 32 members (up to 128 in the experimental format 2, see the [group chat guide](../../docs/guides/groups.md)); the owner is a single point; not audited by a third party.
