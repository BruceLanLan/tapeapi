[English](../channels.md) | 中文

# 私密通道

Tape Channel（[TAP-26](../../../spec/TAP-26.md)）是两个 TapeOut 容器之间一条端到端加密、双向认证的通道。无论由什么
承载（中继服务、WebRTC 连接或链本身），承载方只能看到密文，并且无法在不被发现的情况下伪造、重排或重放帧。最多 32 个
容器的群组见 [TAP-27](../../../spec/TAP-27.md)。

## 工作原理

| 步骤 | 发生了什么 |
|---|---|
| **身份** | 每个容器在其站点的 `.well-known/tape-channel.json` 中发布通道密钥（X25519 用于密钥协商，Ed25519 用于签名），由电路持有者以 EIP-712 签名授权。对方对照**当前**持有者检查这些密钥，因此电路售出后，旧密钥随即失效。 |
| **邀请**（A → B） | A 向 B 发送一份密封给 B 密钥的邀请，投进 B 在中继或 ChannelBus 上的收件房间（或作为 TapeSend 消息发送）。邀请中写明 A 将监听的中继和总线。 |
| **接受**（B → A） | B 经由其中一个传输作答。B 此时已可随之发送数据。 |
| **就绪**（A → B） | A 确认。三次 Diffie-Hellman 提供双向认证、前向保密和抗密钥泄露冒充（即去掉预密钥的 X3DH 核心）。 |
| **帧** | ChaCha20-Poly1305，每个方向一把密钥，使用计数器 nonce，与 WireGuard 和 Noise 相同。 |

## 1. 发布容器的通道密钥

由持有者的钱包签名；私钥保存在你自己保管的文件中：

```bash
node scripts/channel-keys.mjs new --container 0x<container> --identity ./identity.json --days 180 \
  --relay https://relay.example/tapeapi/v1@0x<relay container>
# sign the printed typed data with the holder's wallet (eth_signTypedData_v4), then
node scripts/channel-keys.mjs record --identity ./identity.json --sig 0x<signature>
# prints the record and the putFile transaction that publishes it
```

（先用持有者的钱包签署打印出的类型化数据：`eth_signTypedData_v4`；第二条命令会打印出记录，以及发布该记录的 `putFile`
交易。）

`identity.json` 保存私密材料（文件权限 600）。已发布的记录和交易中都不包含它们。

## 2. 代码中的握手

密码学核心与传输无关：

```js
import { channel } from '@tapeapi/sdk'

// A（发起方）：一份给 B 的邀请，以及一个待完成句柄
const { invite, pending } = channel.createInvite({
  self: { container: A, chainId: 56, staticSecret: aKeys.secretKey },
  peer: { container: B, chainId: 56, staticPublic: bKeys.publicKey },
  relays: [{ url: 'https://relay.example/tapeapi/v1', container: '0x<relay container>' }],
})

// B（响应方）：接受，并得到一个 B 已经可以发送的会话
const { accept, session: bob } = channel.acceptInvite({
  self: { container: B, chainId: 56, staticSecret: bKeys.secretKey },
  peer: { container: A, chainId: 56, staticPublic: aKeys.publicKey },
  invite,
})

// A：完成握手，并得到一条发给 B 的就绪消息
const { ready, session: alice } = channel.completeInvite(pending, accept)
bob.confirm(ready)

const frame = alice.seal('hello')                     // 待承载的字节
bob.open(frame, { text: true }).data                 // 'hello'
```

在真实应用中，对方的公钥来自其已发布的记录（`api.chain.channelKeys(container)`），而邀请、接受和就绪消息经由某个
传输传递。

## 3. 选择传输

| 传输 | 适用场景 | API |
|---|---|---|
| **中继**（默认） | 低延迟，无 gas。中继是一个普通的 TapeAPI 服务，按房间存储密文。 | `channel.relayTransport({ api, svc, inbound, outbound })` |
| **ChannelBus** | 没有需要信任或维持运行的服务器；每条消息都是一笔交易（约 50,000 gas）。 | `channel.busTransport({ rpc, bus: MAINNET.channelBus, inbound, outbound, sendTx })` |
| **同时使用多个** | 响应方可以在邀请所列的任一传输上作答，因此要在所有传输上监听。 | `channel.fanIn([t1, t2])` |

运行中继：[`examples/relay-service/`](../../../examples/relay-service/)（Node）或
[`examples/cloudflare-worker/`](../../../examples/cloudflare-worker/)（每个房间一个 Durable Object）。用
`node conformance/relay.mjs --url <relay>` 检查任意中继。

## 4. 可靠地读取链

ChannelBus 消息是事件，而公共 BNB Chain 节点只保留部分历史，会限制单次回答所含的结果数量，有时还会出错。读取器
（`busTransport`，多房间时用 `busReader`）建立在一条规则之上：**宁可停住，绝不跳过**。当没有任何节点能为某个区块作证时，
游标就停在那里；只有当每个节点都对该区块给出了免责回答时，游标才越过它，并且会告诉你。

| 消息（发给 `warn`，或作为停住的那次轮询的错误） | 含义 | 应对 |
|---|---|---|
| `the cursor has held for N polls at blocks X..Y` | 还没有节点回答这些区块，而某个节点可能仍保留着它们。 | 通常会自行恢复。如果某个节点已永久下线，移除它；如果它只是慢，调大 `budgetMs`。 |
| `RPC_UNAVAILABLE: eth_getLogs: no node serves logs` | 每个节点都以区块太旧为由拒绝了这些区块。 | 读取器的起点早于节点所保留的历史（publicnode 约保留 10,000 个区块）。从更新的 `fromBlock` 开始，或添加一个保留更多历史的节点。 |
| `block N is too old for <node>, so it was read from <others> alone` | 某个节点已不再保留该区块；其它节点代为作答。 | 无需处理；帧已送达。 |
| `block N holds more logs than <node> returns ...` / `was read only from the receipts of ...` | 对某个节点来说过满的区块，改从其它节点读取，或从它们的区块回执中读取。 | 有人用垃圾帧塞满了一个区块；你的帧仍然送达，但只由较少的节点作证。 |
| `<node> has not served for N polls, so blocks from X on are passed without it` | 一个停止作答的节点不再被等待，因此死节点无法让通道停摆。 | 替换或移除该节点。 |

默认节点集（publicnode 加两个 BNB Chain dataseed 节点）正是读取器测试所针对的节点集，测试中也包括这些节点的录制回答。

## 5. 限制

- 一帧最多承载 16 KiB 明文；一份邀请最多存活一小时。
- 中继能看到房间名、大小和时间，永远看不到内容或身份。ChannelBus 会把这些元数据永久公开。
- 在单个方向达到 2^32 帧之前很早就应重新握手（SDK 拒绝超出这一上限）。
