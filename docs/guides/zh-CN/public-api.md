[English](../public-api.md) | 中文

# 公共 API

TapeAPI 在 `https://api.tapeapi.fun` 运行一个免费的公共服务：对 BNB Smart Chain 和 TapeOut 本身的签名、锚定区块的读取，
无需注册，没有密钥。旁边还运行着一个供私密通道使用的免费公共中继。两者都是普通的 TapeAPI 服务；本指南介绍它们提供
什么，以及如何调用。

| 服务 | 身份 | 容器 | 端点 |
|---|---|---|---|
| 公共 API | `11.1013.tape` | `0x1b2A657BcBa9D3229f57aC2f4FcbEE2AA756aAe8` | `https://api.tapeapi.fun/tapeapi/v1` |
| 公共中继 | `12.1013.tape` | `0x9cD838625251576c199B2DeF7A17e50266843185` | `https://relay.tapeapi.fun/tapeapi/v1` |

两个电路都在处理器 1013 上，合约为 `0xe02c26c7432A7121168AA9B610DE24eCf9a1a414`。

## 它是什么

- **免费，无需密钥。** 每个方法都是 0 BEM，直接调用即可。
- **有签名。** 每个回答（包括错误）都是一个信封，由 `11.1013.tape` 的持有者在链上授权的密钥签名
  （[TAP-21](../../../spec/TAP-21.md)）。SDK 核对签名、委托和持有者之后才返回结果。
- **锚定区块。** 除 `blockNumber` 外，每个方法都在同一个区块上读取链（默认是最新的 `finalized` 区块），并在
  `blockPinned { blockNumber, blockHash, blockRef }` 中说明是哪个区块。服务通过三家 BNB Chain 节点运营方读取，至少两家
  一致才算数。
- **限流。** 每个 IP 地址每分钟 600 次免费调用，按固定的一分钟窗口、在每个服务实例上分别计数。超出后服务回答 HTTP 429
  并带 `retry-after` 头（无签名，错误码 `RATE_LIMITED`）；SDK 抛出 `TapeAPIError('RATE_LIMITED')`，等待秒数在
  `e.data.retryAfterS`。

它是一项公共物品，不是平台。这个服务就是 [`examples/public-api/`](../../../examples/public-api/) 里的示例，任何人都可以
用自己的电路运行一个同样的服务（[运行服务](provide.md)）。同样方法的独立提供者越多，交叉核对才越可行（见下文）。

## 用 SDK 调用

```js
import { createTapeAPI } from '@tapeapi/sdk'

const api = createTapeAPI({
  rpcUrls: ['https://bsc-dataseed.bnbchain.org', 'https://bsc-dataseed1.defibit.io', 'https://bsc-dataseed1.ninicoin.io'],
  quorum: 2,
})

const svc = await api.resolve('11.1013.tape')   // <#ID>.<processor>.tape
const { result, block, verified } = await api.call(svc, 'bnbUsd', {})
console.log(result.bnbUsd, result.blockPinned.blockNumber, verified)
```

`api.resolve` 不信任网站服务器：它由电路推导出容器，从容器的链上站点读取清单并对照链核对，再核对持有者对签名密钥的
委托（每一步见[调用服务](consume.md)）。按容器地址 `api.resolve('0x1b2A657BcBa9D3229f57aC2f4FcbEE2AA756aAe8')`，或按
`api.resolve({ circuits: '0xe02c26c7432A7121168AA9B610DE24eCf9a1a414', tokenId: '11' })` 解析，得到的是同一个服务。

## 用 curl 调用

请求是 `POST {endpoint}/{method}`，JSON 请求体为 `{ "id", "params" }`。`id` 是任意 1 到 128 个字符的字符串，会原样
出现在回答里；`params` 是一个 JSON 对象。

```bash
curl -s -X POST https://api.tapeapi.fun/tapeapi/v1/bnbUsd \
  -H 'content-type: application/json' \
  -d '{"id":"doc1","params":{}}'
```

一个真实的回答（哈希与签名已缩写）：

```json
{
  "id": "doc1",
  "ok": true,
  "result": {
    "bnbUsd": "774.349742334346733873",
    "pair": "0x16b9a82891338f9bA80E2D6970FddA79D1eb0daE",
    "blockPinned": { "blockNumber": 124183697, "blockHash": "0xb49b…5d25", "blockRef": "hash" }
  },
  "container": "0x1b2A657BcBa9D3229f57aC2f4FcbEE2AA756aAe8",
  "ts": 1790444986,
  "block": 124183699,
  "sig": "0x9f96…bd1c"
}
```

这里出现两个区块号。`result.blockPinned.blockNumber` 是读取所在的区块（默认是最终确定的区块）；信封的 `block` 是服务
签名时看到的链头。`blockRef: "hash"` 表示节点正是在那个 `blockHash` 上求值；若为 `"number"`，则表示有节点拒绝了按哈希
求值，读取只按区块号进行，[TAP-23](../../../spec/TAP-23.md) 把它视为更弱的证据。

失败的调用同样有签名：

```json
{ "id": "doc4", "ok": false, "error": { "code": "BAD_REQUEST", "message": "address must be a 0x address of 40 hex digits" },
  "container": "0x1b2A657BcBa9D3229f57aC2f4FcbEE2AA756aAe8", "ts": 1790445009, "block": 124183752, "sig": "0xe154…1c" }
```

**仅用 curl 什么也没有验证。** 你和服务之间的任何一方都可以改动这些字节。要信任一个回答，请使用 SDK，或按
[调用服务](consume.md)末尾的说明自行恢复签名者，并与持有者在链上委托的签名者比较。
`https://api.tapeapi.fun/.well-known/tapeapi.json` 上的清单副本只是方便阅读；SDK 使用的是链上那一份。

## 方法

每个方法都免费。凡出现 `block` 的地方它都是可选的：一个区块号，或 `'finalized'`（默认）、`'safe'`、`'latest'`。
回答中的地址是校验和格式；大数是十进制字符串。

| 方法 | 参数 | 返回 | 参数示例 |
|---|---|---|---|
| `blockNumber` | 无 | `blockNumber`：各节点一致认可的最新区块。不锚定区块，不用于多方比对。 | `{}` |
| `balance` | `address`、`block?` | `address`、`wei`、`bnb`（原生 BNB）、`blockPinned` | `{ "address": "0x16b9a82891338f9bA80E2D6970FddA79D1eb0daE" }` |
| `tokenInfo` | `token`、`block?` | `token`、`name`、`symbol`（均为 `string` 或 `null`）、`decimals`、`totalSupply`、`blockPinned` | `{ "token": "0x55d398326f99059fF775485246999027B3197955" }` |
| `tokenBalance` | `token`、`address`、`block?` | `token`、`address`、`raw`、`amount`（以代币为单位）、`symbol`、`decimals`、`blockPinned` | `{ "token": "0x55d398326f99059fF775485246999027B3197955", "address": "0x16b9a82891338f9bA80E2D6970FddA79D1eb0daE" }` |
| `nftOwner` | `contract`、`tokenId`（十进制字符串）、`block?` | `contract`、`tokenId`、`owner`、`blockPinned` | `{ "contract": "0xe02c26c7432A7121168AA9B610DE24eCf9a1a414", "tokenId": "11" }` |
| `pairPrice` | `pair`（PancakeSwap V2 交易对）、`block?` | `pair`、`token0` 与 `token1`（`address`、`symbol`、`decimals`）、`reserves`（`reserve0`、`reserve1`、`blockTimestampLast`）、`price`（`token0InToken1`、`token1InToken0`）、`blockPinned` | `{ "pair": "0x16b9a82891338f9bA80E2D6970FddA79D1eb0daE" }` |
| `bnbUsd` | `block?` | `bnbUsd`（按 PancakeSwap V2 WBNB/USDT 交易对计算的 BNB 的 USDT 价格）、`pair`、`blockPinned` | `{}` |
| `tapeName` | `name`（`'<#ID>.<processor>.tape'`），或 `processor` 加 `tokenId`；`block?` | `name`、`processor`、`tokenId`、`circuits`、`container`、`holder`、`opened`、`tapeapi` 与 `channelKeys`（已发布文件的 `{ path, size, sha256 }`，或 `null`）、`blockPinned` | `{ "name": "11.1013.tape" }` |

参数错误（不是地址、代币不是 BEP-20、电路不存在）会得到一个有签名的 `BAD_REQUEST`，消息里说明是哪一项。实时的方法
列表及其准确类型见清单的 `methods`（`api.resolve` 之后的 `svc.manifest.methods`）。

## 价格与交叉核对

`pairPrice` 和 `bnbUsd` 是由资金池在某个区块的储备量算出的**现货价格**。一笔大额交易可以在一个区块内推动它们，所以不要
单独用它们做清算，或任何攻击者能从操纵中获利的事情。依赖价格的协议应加上边界检查、新鲜度检查、时间加权均价和熔断机制。

签名回答只能证明是谁说的，不能证明它是真的。对于重要的数值，请向第二个独立提供者询问同一个区块，只接受逐字节相同的
结果。描述以 `[quorum]` 开头的每个方法（除 `blockNumber` 外的全部）都接受数字形式的 `block`，正是为此：

```js
const other = await api.resolve('0x<另一家提供者的容器>')
const first = await api.call(svc, 'bnbUsd', {})
const block = first.result.blockPinned.blockNumber
const q = await api.callQuorum([svc, other], 'bnbUsd', { block }, { quorum: 2 })
console.log(q.result.bnbUsd, 'agreed by', q.agreed)   // 否则抛出 TapeAPIError('QUORUM_FAILED')
```

`callQuorum` 拒绝共用容器、持有者或端点来源的服务，因为它们只算一个来源，不算两个。目前 `api.tapeapi.fun` 是这些方法
唯一的公共提供者，所以第二个提供者需要由你或其他人运行，可以用 [`examples/public-api/`](../../../examples/public-api/)，
也可以用你自己的代码。

## 公共中继

中继承载 [TAP-26](../../../spec/TAP-26.md) 私密通道：两个容器通过中继上的房间交换端到端加密的帧，中继只存储密文，
永远看不到内容或身份（它能看到房间名、大小和时间）。公共中继位于 `https://relay.tapeapi.fun`，身份 `12.1013.tape`，
容器 `0x9cD838625251576c199B2DeF7A17e50266843185`，提供 `relaySend`、`relayHandshake` 和 `relayRecv`，每条消息零费用。

在邀请中列出它，然后用 `channel.relayTransport` 通过它承载通道：

```js
import { channel } from '@tapeapi/sdk'

const relay = await api.resolve('12.1013.tape')   // container 0x9cD838625251576c199B2DeF7A17e50266843185

const { invite, pending } = channel.createInvite({
  self: { container: A, chainId: 56, staticSecret: aKeys.secretKey },
  peer: { container: B, chainId: 56, staticPublic: bKeys.publicKey },
  relays: [{ url: 'https://relay.tapeapi.fun/tapeapi/v1', container: relay.container }],
})

// （邀请密封后送到 B；B 接受，并把 accept 发到中继）
const rooms = channel.roomsFor(invite.cid)            // 握手完成前 A 的房间
const link = channel.relayTransport({ api, svc: relay, inbound: rooms.toInitiator, outbound: rooms.toResponder })
const [w] = await link.poll()
const { ready, session } = channel.completeInvite(pending, channel.decodeWire(w).handshake)
await link.send(channel.encodeWire(ready))
await link.send(channel.encodeWire(session.seal('hello')))
```

响应方在自己会话的房间（`session.rooms.inbound`、`session.rooms.outbound`）上打开自己的传输；`link.start(onWire)` 会在
后台持续轮询。要在容器的通道密钥中声明这个中继，给 `scripts/channel-keys.mjs` 传
`--relay https://relay.tapeapi.fun/tapeapi/v1@0x9cD838625251576c199B2DeF7A17e50266843185`。完整的握手、其它传输以及
运行自己的中继，见[私密通道](channels.md)。

## 限制与状态

- Pre-alpha。两个服务都免费，尽力而为地运行，没有 SLA，也不保证可用性。方法可能增加；方法列表的变化会作为新的清单
  发布到链上。
- 中继可能丢帧或下线；TAP-26 能发现空缺，但无法补回。如果通道很重要，在邀请中列出不止一种传输。
- 对你所依赖的东西，也运行你自己的提供者或中继，并做交叉核对。
