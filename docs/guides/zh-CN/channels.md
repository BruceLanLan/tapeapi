[English](../channels.md) | 中文

# 私密通道

Tape Channel（[TAP-26](../../../spec/TAP-26.md)）是两个 TapeOut 容器之间一条端到端加密、双向认证的通道。无论由什么
承载（中继服务、WebRTC 连接或链本身），承载方只能看到密文，并且无法在不被发现的情况下伪造、重排或重放帧。最多 32 个
容器的群组见 [TAP-27](../../../spec/TAP-27.md)；在应用里接入群聊见[群聊](groups.md)。

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
| **中继**（默认） | 低延迟，无 gas。中继是一个普通的 TapeAPI 服务，按房间存储密文。 | `channel.relayTransport({ api, service, inbound, outbound })` |
| **ChannelBus** | 没有需要信任或维持运行的服务器；每条消息都是一笔交易（约 50,000 gas）。 | `channel.busTransport({ rpc, bus: MAINNET.channelBus, inbound, outbound, sendTx })` |
| **同时使用多个** | 响应方可以在邀请所列的任一传输上作答，因此要在所有传输上监听。 | `channel.fanIn([t1, t2])` |

一个免费的公共中继运行在 `https://relay.tapeapi.fun`（TapeOut 名称 `12.1013.tape`）；如何在邀请中写明它、让通道经由它
传输，见[公共 API](public-api.md) 的"公共中继"一节。自己运行中继：[`examples/relay-service/`](../../../examples/relay-service/)（Node）或
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

读 ChannelBus 需要提供 `eth_getLogs` 的节点，而 BNB Chain dataseed 节点拒绝这个方法。请使用 SDK 的 `BUS_RPC_URLS`
（48 Club 与 1RPC 提供日志、历史至少 500,000 个区块，另加一个 dataseed 提供回执），并单独建一个客户端：
`createRpc({ urls: BUS_RPC_URLS, quorum: 2, timeoutMs: 15000 })`。用这组节点，读取器读回了 73,700 个区块之前的真实帧
（2026-09-27）。读取器的测试包含 publicnode 与 dataseed 节点的录制回答。中继传输完全不依赖这一点。

## 5. 读取隐私

1.0 中为实验性：下面的选项、默认值与 `stats().privacy` 可能在 1.x 的次版本里改变。

`busTransport` 与 `busReader` 按名字向每家节点询问你的房间：一次 `eth_getLogs`，其房间 topic 列出这些房间，发给客户端的
2 到 4 家运营方。每家节点因此都看到"这个 IP 在读这些房间"；收件房间由容器地址推导（`channel.inboxRoom`），节点就能把
容器对到 IP 上。`busPrivacy.busPrivacyReader` 的参数与返回值与 `busReader` 相同，只改变向节点问什么。它降低节点把你的 IP
与你的房间关联起来的容易程度；它不隐藏你在读 ChannelBus 这件事，也不隐藏读取的时间和数量。

```js
import { busPrivacy, channel, createRpc, BUS_RPC_URLS, MAINNET } from '@tapeapi/sdk'

const rpc = createRpc({ urls: BUS_RPC_URLS, quorum: 2, timeoutMs: 15000 })
const reader = busPrivacy.busPrivacyReader({
  rpc, bus: MAINNET.channelBus,
  rooms: [channel.inboxRoom(myContainer)],
  cover: { store: myStore },      // 任意 { get, set }：万一降级，重启后仍保持同一组掩护
})
reader.start((wire, { room }) => { /* 这里只会收到你自己房间的帧 */ })
console.log(reader.stats().privacy)   // { mode, k, effectiveK, short, pool, fallback, ... }
```

| `mode` | 每家节点看到什么 | 代价 |
|---|---|---|
| `'contract'`（默认） | 不含任何房间：下载总线上的全部帧，在你的机器上筛选。节点只知道"这个 IP 在读 ChannelBus"。 | 总线的全部流量，每次轮询受 `contract.maxBytes` / `maxLogs` 约束（8 MiB、10,000 条，按每个节点的回答累计）。超过时读取器降级到 `'cover'` 并告知（设 `contract.onExceed: 'error'` 时改为以 `BUS_BUDGET` 停下）。 |
| `'cover'` | 你的每个房间混在 `k` 个房间里（默认 8）：你的房间加上别人在这条总线上真实用过的 `k − 1` 个房间，每次请求都重新随机排序。 | 掩护房间的帧也要下载（立即丢弃，从不解密、从不保存）。 |
| `'plain'` | 按名字列出你的房间：即原来的 `busReader`。 | 无。 |

**为什么默认 `'contract'`。** 2026-09-28 实测，主网 ChannelBus 在 500,000 个区块里只有一条日志（部署探针），掩护房间无从
取材，而按合约全量读取几乎没有代价。显式传 `mode: 'cover'` 或 `'plain'` 可另选，二者行为不变。

**第一次读取。** `'contract'` 不需要掩护池：第一次轮询读取 `lookback` 窗口（默认 600 个区块，或从你给的 `fromBlock` 起；
调小 `lookback` 可以少等），在 48 Club 上每个节点一次请求，几秒钟（每个节点各自读取，有一个作答就够；1RPC 每次只收 50 个
区块，它那一份会再拆开）。`'cover'` 要先读池子：每 5,000 个区块一次请求（48 Club 的上限），2026-09-28 实测每次 3 到 6 秒，
按默认 40,000 个区块（`cover.scanBlocks`），新进程要等约 25 到 50 秒才读到第一帧。调小 `cover.scanBlocks`（5,000 即一次
请求），或保存 `cover.store`，重启后只读上次保存以来的区块。1RPC 每次请求至多 50 个区块，没有 48 Club 时池扫描会失败，
掩护只来自 `cover.pool`（并给出警告）。

**降级与恢复。** 任何人都能发垃圾帧（100 美元 gas 约 100 MB），每个按合约全量读取的读者都得下载：预算把这变成降级到
`'cover'`，并告诉 `warn`（`... Switched to 'cover' mode ...`）。这时抽取的掩护优先来自安静的 `'contract'` 轮询里见过的
房间，绝不取自引起降级的垃圾（灌垃圾者自己的房间正是它认得出的掩护），所以降级不需要等一次完整扫描。读取器会自动回到
`'contract'`（`... back to 'contract' mode ...`），并带滞后：超过预算就离开；回来则要在 `'cover'` 里待满 `contract.retryMs`
（30 分钟；回来后不久又降级，就加倍，至多 24 小时），**并且**降级之后的一次池刷新显示一次轮询的流量不超过预算的**一半**。
回来是值得的，因为 `'contract'` 不写明任何房间；来回切换本身透露得很少，因为掩护只抽一次、保持不变，每段 `'cover'` 显示的
都是同样的组，而且所有默认读者都在同一时刻切换。`contract.retryMs: null` 表示留在 `'cover'`。`stats().privacy.fallback`
给出何时降级、最早何时可回来。

**`k` 的含义。** 在 `'cover'` 模式下，单凭一次请求，节点猜中哪个房间是你的概率是 1/`k`。默认 `k = 8`，因为成本线性增长
（你的每个房间要多下载 `k − 1` 个别人房间的帧，池子也要这么大），而下面列出的攻击并不会因为 `k` 更大而减弱。每次请求至多
带 128 个房间 topic（`cover.maxTopics`；2026-09-28 实测 BUS_RPC_URLS 的节点接受 256 个、拒绝 1,024 个），`k = 8` 时可
容纳你的 16 个房间。

**掩护从哪里来、为什么不换。** 掩护池是最近 40,000 个区块（约 5 小时）里这条总线日志出现过的房间（用不含任何房间的查询
读取），加上安静的 `'contract'` 轮询见过的房间，再加上你在 `cover.pool` 里给的房间，例如已知容器的 `channel.inboxRoom()`。
掩护在某个房间第一次以 `'cover'` 模式读取时随机抽取，之后保持不变：读者整个生命周期内不变，给了 `cover.store` 时重启后也
不变。更换掩护反而会暴露它们：节点能关联起来的两次请求（同一 IP，或者只因为含有你的同一组房间）会暴露它们的共同部分；
掩护变了而你的房间没变，共同部分恰好就是你的房间。后加入的房间在它自己的掩护之中补读；移除房间时它的掩护一起移除；再加
回来时还是同一组掩护。

**池子太小时**读取器绝不假装有掩护。它用现有的掩护读取，在 `stats().privacy` 里报告 `effectiveK` 与 `short`，并且每次变化
时告诉 `warn` 一次：`only N cover rooms ... 1 in E, not 1 in 8`，或 `no cover rooms available ... the nodes see exactly
which rooms this reader reads`。设 `cover.onShort: 'error'` 时改为抛出 `BUS_PRIVACY`，在任何列出房间的请求发出之前。
目前降级到 `'cover'` 时遇到的就是这种情况，除非你传入 `cover.pool`。

能挡什么、挡不住什么：

- `'contract'` 不写明任何房间；`'cover'` 让逐次查看你请求的节点分不清你的房间和掩护。
- **垃圾帧会迫使降级。** 把总线灌到超过预算的人，能让默认读者在一段时间里把房间混在掩护中写明；加倍的等待限制的是这能
  重复多频繁，而不是能不能发生。
- **邀请之后新增房间。** 在 `'cover'` 模式下，邀请落到你的某个房间、读取器随后加入一个通道房间时，节点能把两者关联起来。
  随机延迟后再加入房间，或预先登记备用房间，能增加难度，但不能杜绝。
- **掩护池的来源。** 池子的规则是公开的，所以你读的房间如果不在近期活跃池里就会显眼；池扫描时撒谎的节点可以塞进它知道是假的
  房间；任何人都能以每个约 50,000 gas 的代价往自己的房间发帧，用它认得出的掩护灌满池子。
- **不保存状态的会话。** 没有 `cover.store` 的新读者会抽取新的掩护，同时看到两次会话的节点能在交集里找到你的房间。
- 时间、IP 地址与数量对你查询的节点都不隐藏。通过自己运行的节点读取，这些请求就不会被第三方看到。

## 6. 限制

- 一帧最多承载 16 KiB 明文；一份邀请最多存活一小时。
- 中继能看到房间名、大小和时间，永远看不到内容或身份。ChannelBus 会把这些元数据永久公开。
- 在单个方向达到 2^32 帧之前很早就应重新握手（SDK 拒绝超出这一上限）。
