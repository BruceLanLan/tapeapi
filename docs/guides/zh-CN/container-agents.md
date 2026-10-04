[English](../container-agents.md) | 中文

# 容器代理（实验性）

容器代理，就是让一个 TapeOut 容器替另一个容器办一件事：容器 + 代理 = 容器代理。委托方容器的持有人签一份授权书，点名
由哪个容器来办；代理对自己交出的东西签名；任何人都能拿着整条往来记录到链上核对。（如果你要找的是让浏览器里的 AI 模型
调用工具，那是另一项功能，见 [AI 智能体](agents.md)。）

## 它是什么，不是什么

1.7 版通过子路径 `@tapeapi/sdk/agent` 提供的是**阶段 0**：

- **授权书是一份签名声明，不是门禁。** 委托方容器的持有人用 EIP-712 签下：交给哪个代理容器、办什么任务（以哈希表示）、
  可以调用哪些服务、从什么时候到什么时候。链上没有任何东西执行这些约定，每个核验结果都写着 `enforcement: 'none'`。
- **它不授权任何钱。** 既然没有东西能守住额度，写了任何金额或资产的授权书一律拒绝：每个 `cap` 和 `feeCap` 必须是 `0`，
  每个 `token` 和 `feeToken` 必须是零地址，`subdelegate` 必须是 `false`（问题码 `phase0-no-funds` 或
  `subdelegate-not-allowed`）。SDK 自己的钱包载荷和本地签名入口从一开始就不会生成这样的授权书。
- **要付钱，就是一笔普通转账。** SDK 帮你构造转给代理容器的未签名交易，事后再从链上只读地核验。它从不签名、不发送、
  不代付 gas，也不经手资金。
- **有约束力的额度是以后的阶段。** 让代理无法超支的上限，需要尚未部署的合约（见[接下来](#接下来)）。
- **实验性。** 整个子路径按 [1.0 的承诺](upgrade-1.0.md)属于"实验性"：可能在 1.x 的次版本里改动，不在 1.x 兼容承诺之内。
  格式跟随 TapeOutProtocol/TAPs 里的两个公开讨论：Idea [#40](https://github.com/TapeOutProtocol/TAPs/issues/40)（授权书）
  与 [#41](https://github.com/TapeOutProtocol/TAPs/issues/41)（任务协议与代理上架），讨论有变化，格式也会跟着变。两者都还
  没有 TAP 编号。

## 谁签什么

| 角色 | 是什么 | 谁签名 |
|---|---|---|
| 委托方 | 发起雇佣的容器 | 其电路的**当前持有人**（ECDSA 私钥，或者合约持有人经 EIP-1271）。清单里委托的签名者不能代签。 |
| 代理 | 办事的容器，带 TAP-11 清单 | 它的清单公布的签名者：代理发出的每条消息，都是它某个方法的签名回答。 |
| agentKey | 代理为这一单新生成的地址 | 阶段 0 里谁也不用它签：授权书只把它绑定进来，不使用它。 |
| 上游服务 | 代理为完成任务去调用的服务 | 各自清单的签名者，体现在代理收集的回执里。 |

持有人签的是 TAP-11 委托域里的四种 EIP-712 类型（name 为 `TapeAPI`，version 为 `1`，链的 chainId，DeWEB hub 作
`verifyingContract`）：`TaskOffer`、`Mandate`、`TaskVerdict`、`MandateRevocation`。类型名会进每个哈希，所以对一种类型的
签名永远不会被当成另一种类型的签名，也不会被当成委托。持有人签下的摘要同时就是这条消息的身份：`offerHash`、
`mandateHash`、`verdictHash`。测试向量见 [`spec/vectors/container-agent.json`](../../../spec/vectors/container-agent.json)，
完整的类型声明见 [`sdk/types/agent.d.ts`](../../../sdk/types/agent.d.ts)。

## 任务线程

一件任务就是一串消息，每条形如 `{ "v": 0, "kind": "tape.agent/<类型>", ... }`，按收到的顺序排列：

```text
委托方（持有人签名）                                  代理（清单签名者签名）

1. offer        报价 TaskOffer + 任务原文   ------->
                                            <-------  2. accept    offerHash，为这一单新生成的 agentKey
3. mandate      授权书 Mandate，写明该 agentKey ---->
                                                         代理只调用授权范围内的服务
                                            <-------  4. deliver   deliverableHash，只含哈希的回执
5. acceptance   验收 TaskVerdict：1 通过，2 拒收 --->
6. revocation   撤销 MandateRevocation，随时可发（或放在委托方站点上的撤销清单里）
```

状态依次是 `Offered`、`Accepted`、`Active`、`Delivered`、`Settled`，另有三个出口：`Expired`、`Rejected`、`Cancelled`。
动手之前值得先知道几条规则：

- 任务原文必须能算出 `offer.taskHash`（规范 JSON 再取 keccak256，即 `taskHashOf(task)`）。
- 授权书里的委托方、任务、mode、nonce 必须与报价一致（`mandate.nonce` 等于 `offer.nonce`，所以一张授权书不能用在两个
  线程里），`agentKey` 必须是代理在 accept 里公布的那一把。
- `notBefore` 与 `expires` 最多相隔 30 天。
- 报价里的 `fee` 只是一句报价，不授权任何付款；它不为零时，SDK 会给控制台一条提示，把这一点说清楚。
- 晚于报价 `deadline` 的交付照样记录，但会报 `deliver-after-deadline`。被拒收后，代理可以在授权书有效期内重新交付。
  没有仲裁：交付过了自身的 `exp` 还没等到验收，状态仍是 `Delivered`，并标上 `unaccepted: true`。
- 付款不是一个状态。它是链上的事实，单独核验。
- 撤销不论是线程里的消息（放在哪个位置都一样），还是委托方站点上的清单，都只影响在它之后签名的东西。它只设定线程的
  撤销时间：签名晚于这个时间的代理消息被拒（`message-after-revocation`）；验收不受这个时间限制，所以撤销之前的交付仍然
  可以被验收或拒收；只有最后检查时，仍处在 `Offered`、`Accepted` 或 `Active` 的线程才判为 `Cancelled`（先于 `Expired`）。
  同一份撤销走两条路，结果相同。线程里不报 `mandate-revoked`。
- `quote`、`progress`、`reject`、`cancel`、`dispute` 是 Idea #41 里出现的名字，这一版没有实现：线程里出现其中任何一个，
  都会被拒（`kind-not-implemented`）。

消息怎么送达，由双方自己决定。下面的示例里，代理的每条消息都是它某个方法（`task_offer`、`task_mandate`、
`task_deliver`、`task_status`）的签名回答。

## 三分钟跑起来

[`examples/agent-service/`](../../../examples/agent-service/) 里的示例能离线跑完一整单：委托方容器、代理容器和两个服务
容器都在 SDK 的假链上，全在一个进程里。不联网、不花钱、不用钱包。在一份干净的仓库里（先 `npm install` 一次）：

```bash
node examples/agent-service/hire.mjs                 # 报价、接单、授权书、交付、核验线程、验收
node examples/agent-service/hire.mjs --same-holder   # 同一单，但两个容器属于同一个持有人
node examples/agent-service/hire.mjs --pay           # 另外把付款构造成未签名交易
```

第一条命令一次运行的节选（完整输出还会逐字段打印要交给钱包签名的三份载荷；本页节选里 32 字节的哈希都用 `…` 省略了中间部分）：

```text
2. accept: agentKey 0x777C98D739d42C482B9F96E1F1B251f8bD95473F (made for this order), valid until 1791003600
3. mandate: what a wallet would be asked to sign (a statement, not a gate: enforcement none)
   typed data Mandate (domain TapeAPI 1, chain 56, hub 0x1010101010101010101010101010101010101010)
     ...
     scope: [{"provider":"0x5e5E5e5e5E5e5E5E5e5E5E5e5e5E5E5E5e5E5E5e","token":"0x0000000000000000000000000000000000000000","cap":"0"}]
     feeToken: 0x0000000000000000000000000000000000000000
     feeCap: 0
     ...
   console notice (not sent to the wallet): phase 0: this mandate authorises no amount and no asset; it is only a verifiable record that you asked this agent to act for your container on this task
   the agent verified the mandate and started: state working
4. delivery: 1 upstream receipt(s), deliverable hash matches; deliverable (data): {"kind":"chain.block-height","chain":"bsc","blockNumber":62000000,...}
5. thread: state Delivered  ok true  enforcement none  selfHire false
   ...
   thread: state Settled  ok true  enforcement none  selfHire false
     verdict accepted (verdictHash 0xafdd669c…7d7521)
```

线程最后到达 `Settled` 时，脚本以 0 退出。里面的一切都是假链的夹具：hub `0x1010…` 和这些容器在别处都不存在（真实的
hub 地址见[简介](introduction.md#链上地址)），假链也有自己固定的时钟。`agentKey` 每一单都重新生成，所以它以及依赖它的
哈希每次运行都不一样。

加上 `--same-holder`，线程照样通过核验，但核验结果会说明背后是谁：

```text
5. thread: state Delivered  ok true  enforcement none  selfHire true (same-holder)
```

自己雇自己会被标出来，既不隐藏也不拒绝：协议没有办法阻止这件事。信誉类规则应当把这样的线程排除在外。

`hire.mjs` 签名用的是假链的测试夹具。不要把它们用到真链上，也不要把真实钱包的私钥放进这个示例：真实的委托方在钱包里
签同样的载荷，做法见下一节。

## 在你自己的代码里

按[调用服务](consume.md)里的方法安装 SDK；代理相关的函数都从子路径 `@tapeapi/sdk/agent` 引入。每项核验都要读链，所以
客户端至少要配置两家独立运营方的节点（决定性的读取在严格共识下进行）；只有一个节点的客户端会被拒绝。

### 签一份授权书

持有人在钱包里签名。你的控制台负责构造载荷、显示钱包显示不了的内容，交给钱包的只有载荷本身：

```js
import { createTapeAPI } from '@tapeapi/sdk'
import { createAgentKit, MODE_PAY, taskHashOf, mandateTypedData, forWallet } from '@tapeapi/sdk/agent'

const api = createTapeAPI({
  rpcUrls: ['https://bsc-dataseed.bnbchain.org', 'https://bsc-mainnet.public.blastapi.io', 'https://rpc-bsc.48.club'],
  quorum: 2,
})
const kit = createAgentKit(api)
const { chainId, hub } = kit                         // 本控制台自己配置的链与 hub

const ZERO = '0x0000000000000000000000000000000000000000'
const PRINCIPAL = '0x000000000000000000000000000000000000a001'   // 你的容器
const AGENT = '0x000000000000000000000000000000000000a002'       // 代理的容器
const AGENT_KEY = '0x000000000000000000000000000000000000a003'   // 代理 accept 里公布的 agentKey
const PROVIDER = '0x000000000000000000000000000000000000a004'    // 允许代理调用的服务

const now = Math.floor(Date.now() / 1000)
const task = { kind: 'chain.block-height', chain: 'bsc', spec: 'Read the BNB Smart Chain block height' }
const mandate = {
  principal: PRINCIPAL, agent: AGENT, agentKey: AGENT_KEY, mode: MODE_PAY, taskHash: taskHashOf(task),
  scope: [{ provider: PROVIDER, token: ZERO, cap: '0' }],   // 阶段 0：代币为零地址，上限为 0
  feeToken: ZERO, feeCap: '0',
  notBefore: now - 60, expires: now + 86_400,               // 最多相隔 30 天
  nonce: '1',                                               // 与报价的 nonce 相同
  subdelegate: false,
}
const td = mandateTypedData(chainId, hub, mandate, { task })
const { payload, warnings, display } = forWallet(td, { chainId, hub })
console.log(Object.keys(payload))   // [ 'domain', 'types', 'primaryType', 'message' ]
console.log(warnings[0])            // phase 0: this mandate authorises no amount and no asset; ...
// 在持有人的浏览器钱包里：
// const sig = await ethereum.request({ method: 'eth_signTypedData_v4', params: [holderAddress, JSON.stringify(payload)] })
```

把这四个地址换成真实的。`display` 里是任务原文（已对照 `taskHash` 核过）和用文字写出的两个日期：请把它们显示在钱包
弹窗旁边，因为钱包里的 `taskHash` 只是一串 32 字节。

**为什么 `forWallet` 必须传 `{ chainId, hub }`。** `forWallet` 会用 SDK 重新构造一遍载荷，凡是与 SDK 构造结果不同的
（多了一个类型字段、domain 形状被改过）一律拒绝；它还会去掉 `warnings` 和 `display`，这两项只给控制台看，既不进哈希也
不进签名。但它只能按传进来的 domain 去重建：单靠它自己，看不出载荷被换成了另一条链或另一个 hub，而签名一旦签下，就
能拿到那里重放。所以控制台要传入自己配置的链和 hub，绝不能从载荷里读；缺了或对不上都会被拒绝：

```text
forWallet(td)                       -> AGENT_INVALID: forWallet: the holder's console must pass the chainId and hub it expects: forWallet(td, { chainId, hub })
forWallet(td, { chainId: 97, hub }) -> AGENT_INVALID: forWallet: the payload is for chain 56, the console expects 97
```

写了金额的授权书走不到这一步：

```text
mandateTypedData(chainId, hub, { ...mandate, feeCap: '1000' })
  -> AGENT_INVALID (data.reason 'phase0-no-funds'): mandateTypedData: phase 0 has no enforcement: every scope cap and feeCap must be 0 ...
```

这道闸防的是失误，防不了恶意的控制台：摘要总是算得出来，不经过这个 SDK 也能签。持有人真正的防线是钱包里显示的字段：
`feeToken` 与每个 `token` 都是零地址，每个 `cap` 与 `feeCap` 都是 `0`，`subdelegate` 是 `false`。

`taskOfferTypedData`、`taskVerdictTypedData`、`mandateRevocationTypedData` 用法相同，同样要经过 `forWallet`。

### 核验一条任务线程

双方中的任何一方，或者任何拿到这些消息的人，都可以核验一条线程：

```js
import { createAgentKit, plainText } from '@tapeapi/sdk/agent'

const kit = createAgentKit(api, { nonces: new Map() })
const check = await kit.verifyTaskThread(messages)   // 按收到的顺序排列的消息
console.log(check.state, check.ok, check.enforcement, check.selfHire, check.selfHireReasons)
for (const p of check.problems) console.log(p.code, plainText(p.message))
```

对 `hire.mjs` 产生的线程，它打印 `Settled true none false []`。把任务原文改掉一个词，它打印 `null false none false []`，
后面跟着一串问题，第一条是 `task-hash-mismatch messages[0]: the task text does not hash to offer.taskHash`。（在示例的
假链上，kit 还要拿到这个世界固定的时钟：`createAgentKit(api, { clock })`。）

结果里还有双方的身份（`principal`、`agent`：容器地址、链上给它的名字或 `null`、持有人）、每次交付及其证据核验、验收和
撤销情况。代理清单里写的名字只会出现在 `agent.displayName` 里，并标着 `untrusted: true`。对方写的任何文字，都请用
`plainText` 显示，它会去掉不可见字符和控制字符。

kit 能不能察觉跨时间的问题，取决于两个存储。`nonces`（一个 `Map`，或者一个 `setIfAbsent(key, value)` 一步完成并返回
先前值的存储）用来发现 nonce 重用：只有保存它的一方才看得到。`revocationFloor`（`{ get, set }`）记住每个委托方见过的
最新撤销清单。两者默认都只在内存里；长期运行的服务应当把它们放进进程重启后仍在的存储。

代理在开工前自己核验授权书，传入它公布的那把钥匙和它自己的容器：

```js
const v = await kit.verifyMandate(mandateMessage, { agentKey, agent: myContainer })
if (!v.ok) throw new Error(v.problems.map((p) => p.code).join(', '))
```

### 核验一笔付款

收款方永远从链上读，绝不从任何文字里取：

```js
import { createPaymentKit } from '@tapeapi/sdk/agent'

const pay = createPaymentKit(api)
const { circuits, tokenId } = await kit.identityOf(agentContainer)   // 从链上读出
const tx = await pay.transferToContainer({ circuits, tokenId, token, amount: '1000000000000000000' })
for (const line of tx.summary) console.log(line)   // 每个字段都写成文字：拿去和钱包逐项对照
// 钱包签名并发送 { to: tx.to, data: tx.data, value: tx.value }
```

在示例的假链上，摘要是这样的：

```text
to: 0xB0B0b0B0B0B0B0b0B0B0B0b0b0b0b0B0b0b0B0B0
value: 0 (smallest unit of the native coin)
call: transfer(to = 0xa6a6A6a6a6a6A6A6A6a6A6a6a6a6a6a6a6a6a6A6, amount = 1000000000000000000 (smallest unit, 18 decimals) = 1 tokens) on token 0xB0B0b0B0B0B0B0b0B0B0B0b0b0b0b0B0b0b0B0B0
recipient container: 0xa6a6A6a6a6a6A6A6A6a6A6a6a6a6a6a6a6a6a6A6, circuit 0x5050505050505050505050505050505050505050 #12, held by 0x7564105E977516C53bE337314c7E53838967bDaC
```

背后的规则：

- 收款方用 `{ circuits, tokenId }` 或链上名字（`{ name: '<#ID>.<处理器>.tape' }`）指定，再经工厂与 hub 推导出容器地址。
  直接传入的地址（`to`、`container`、`recipient`、`address`）一律拒绝，报 `recipient-not-from-chain`；没人持有的 #ID 也
  拒绝（`no-such-token`）：hub 对任何 #ID 都能推导出地址，转给未铸造的 #ID 的钱，谁也取不出来。
- 只构造 `transfer`，从不构造 `approve`。`decimals()` 从链上读。`nativeToContainer` 转原生币，而且只允许从持有人钱包
  直接转到容器。
- `viaContainer({ from, tx })` 把 ERC-20 转账包进付款方容器的 `execute`，只接受 `transferToContainer` 原样返回、没被改过
  的那个对象。
- 转账之后，给代理发一条 TapeSend 消息，把这笔转账作为资产附件带上（`encodeContent`），而且要第一个发：只有在这之间你
  没有别的消息到达这个收件人、并且消息在 3,600 秒内跟上，这笔付款才算数。`paymentOrder()` 在你的客户端里盯着这件事
  （记录转账、检查下一条消息带上了它；转账被回滚、取消或加速时用 `dropTransfer` 或 `replaceTransfer`）。

收款方从链上核验：

```js
const msg = await pay.readMessage({ recipient: agentContainer, inboxIndex })
for (const r of await pay.verifyAttachments(msg)) console.log(r.attachment.type, r.attachment.amount, r.result)
// erc20 1000000000000000000 ok
```

只有 `ok` 能证明：发件人的钱包为这条消息，把这个数额付给了这个容器。其余结果来自 TAP-10 §19 的十五步：`pending`（还没
终局）、`mismatch`（没有这笔转账、转账回滚了，或者数额、收款方对不上）、`unavailable`（链暂时答不上来）、
`unverifiable`（原生币转账没有直接转到容器）、`late`（转账晚于消息）、`indirect`（消息是经合约写入的）、
`third-party`（是别人付的钱）、`stale`（转账与消息相隔超过 3,600 秒）、`crowded`（中间隔了 60 条以上消息）、
`not-first`（这期间发件人给这个收件人发过别的消息）、`other-chain`，以及 `repeat`（同一笔交易附了两次）。SDK 不内置
已知代币名单：用 `createPaymentKit(api, { tokenAllowed })` 标出你自己认的代币，否则所有代币都按中性显示。

## 命令行

SDK 自带的命令行工具 `tapeapi-verify` 可以核验一条存成 JSON 数组的线程：

```bash
tapeapi-verify task thread.json
tapeapi-verify task thread.json --payment <代理容器> <收件箱序号>
tapeapi-verify task thread.json --rpc https://node-a.example,https://node-b.example
```

不想安装，可以用 `npx -y --package=https://github.com/BruceLanLan/tapeapi/releases/download/v1.7.1/tapeapi-sdk-1.7.1.tgz tapeapi-verify task thread.json`；
在仓库里则是 `node sdk/bin/tapeapi-verify.js task thread.json`。

- `--payment <收款容器> <序号>` 另外核验该收件箱里那个序号的 TapeSend 消息。收款容器必须是线程里的代理，发件方必须是
  线程里的委托方。只支持公开（未加密）的消息。
- `--rpc` 接一个逗号分隔的节点列表，至少来自两家运营方。默认是三家不同运营方的公共节点。
- 退出码：`0` 线程通过（带 `--payment` 时付款也通过），`1` 未通过或读不了链，`2` 用法错误。
- 每次运行的 nonce 存储和撤销下限都是空的，所以单次核验看不出 nonce 重用，也看不出有人放回了一份旧的撤销清单。

下面是示例线程的报告，由同一段命令代码对着示例的离线假链运行得出：

```text
tapeapi-verify task: 5 message(s), chain 56   EXPERIMENTAL
state:       Settled
result:      ok
enforcement: none (phase 0: a mandate is a signed statement; nothing enforces it)
self-hire:   no
principal:   0x86DDaEF00401E3F10418398D67D7189fc458eA95  name (none on the chain's processor table)  holder 0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A
agent:       0xa6a6A6a6a6a6A6A6A6a6A6a6a6a6a6a6a6a6a6A6  name (none on the chain's processor table)  signer 0x1563915e194D8CfBA1943570603F7606A3115508
             manifest name (untrusted: the agent wrote it, it is not an identity): "Report agent"
...
verdict:     accepted at 1791000000 (verdictHash 0x69bb45f4…df05c3)
revocation:  none
problems:    none
payment:     message 0 in the inbox of 0xa6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6: ok
  erc20 0xb0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0 1000000000000000000 in 0xaaaaaaaa…aaaaa1: ok
  the message body names the thread's verdictHash (information only)
```

`revocation` 一行给出线程的撤销时间（有撤销适用时）：签名晚于它的代理消息被拒，仅此而已。它不表示线程被取消，是否取消看
`state` 一行。一条在撤销之前已经交付并验收的线程，会显示 `result: ok` 和 `revocation: at <issued> (site); ...`。

## 核验能证明什么，不能证明什么

一条通过核验的线程能证明：

- **谁签了什么。** 报价、授权书、验收以及撤销，都是委托方容器电路的当前持有人签的；accept 和交付，是代理容器当前清单
  公布的签名者签的。
- **各部分是一回事。** 任务原文对得上报价，授权书对得上报价和代理公布的钥匙，交付指向这张授权书，验收指向这次交付。
- **代理的上游调用是谁回答的。** 交付里的每张回执，都由所列容器此刻公布的签名者签名，该容器在授权范围内，回执自称的
  时间落在授权书的有效期内。回执只含哈希，委托方的请求内容不会公开。
- **钱到了代理的容器**（`verifyAttachments` 说 `ok` 时）：发件人的钱包把这个数额的这种代币付给了这个容器，携带它的消息
  是第一条，而且在一小时之内。

它不能证明：

- **活儿干对了。** 不能证明那些调用是必要的、回答是对的、交付物正确或完整。每个证据核验结果都在 `proves` 与
  `doesNotProve` 里原样写着这几句。任务哈希绑定的是任务原文，不是结果。
- **代理守了授权书。** 没有任何东西能阻止代理调用别的服务，或者用它通过别的途径够得着的钱。阶段 0 里，它调用的服务
  根本看不到授权书。
- **双方是不同的人。** `selfHire` 会标出自雇（`same-container`、`same-holder`、`agent-signer-is-principal-holder`、
  `agent-key-is-principal-holder`），但不会拦下。
- **付款与这单任务的关系。** 阶段 0 的付款与授权书无关：付款前，持有人看到的只是一笔普通转账。

## 怎么撤销

有两条路，核验方两条都会看：

1. **发一条消息。** 签一份 `MandateRevocation` 发给代理，或者放进线程里。不花钱，只约束收到它的人。
2. **在你容器的站点上放一份撤销清单**，路径是 `.well-known/tapeapi-mandates.json`。任何人核验授权书时都会去读。写入它
   是持有人钱包发出的一笔站点交易，gas 由持有人付。

一份撤销最多列 24 个授权书哈希；配合 `revokedBefore`，还能把该委托方所有 `notBefore` 更早的授权书一并撤销（填 `0` 表示
不按日期撤销）。一次要撤销超过 24 张，就按日期撤。文件请用 `revocationFileBytes` 生成：它以紧凑格式写出并做检查。文件
必须放得进 4,096 字节，而一份写满的清单如果美化输出就放不下了。

```js
import { abi } from '@tapeapi/sdk'
import { mandateRevocationTypedData, forWallet, revocationFileBytes, MANDATES_KEY } from '@tapeapi/sdk/agent'

const revocation = { principal: PRINCIPAL, mandateHashes: [mandateHash], revokedBefore: 0, issued: Math.floor(Date.now() / 1000) }
const { payload } = forWallet(mandateRevocationTypedData(chainId, hub, revocation), { chainId, hub })
const sig = await ethereum.request({ method: 'eth_signTypedData_v4', params: [holderAddress, JSON.stringify(payload)] })
const bytes = revocationFileBytes({ chainId, revocation, sig })
const sha256 = '0x' + Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (b) => b.toString(16).padStart(2, '0')).join('')
const putFile = {                                    // 交给持有人的钱包发送
  to: api.addresses.siteRegistry, value: '0x0',
  data: abi.encodeCall('putFile', [PRINCIPAL, MANDATES_KEY, 'application/json', sha256, abi.toHex(bytes)]),
}
```

清单上了站点之后，`kit.readRevocations(PRINCIPAL)` 返回 `status: 'published'`，单独核验那张授权书（`kit.verifyMandate`）
会报 `mandate-revoked: revoked by the principal's holder at <issued> (site)`。在线程里，清单和撤销消息一样只设定撤销时间
（见上面的任务线程）。

清单是这样读的：

- 读法和清单文件一样：从该链上第一个有该容器文件的站点存储读取（本版每条链只有一个站点存储），而且只在站点存储与付费合约运行的是 TAP-10 接受的代码时
  才读；`chunkCount` 为 0 即没有文件；字节必须与链上声明的长度和 SHA-256 一致，不能以字节顺序标记（BOM）开头，当前持有人
  的签名必须成立。`issued` 最多只能比核验方的时钟超前 300 秒。链或站点存储没有这样一份接受实现列表时，`createAgentKit`
  在创建时就拒绝（`INVALID_ARGUMENT`）。
- 核验方会记住见过的最高 `issued`。如果拿到更旧的清单（有人把被替换掉的旧清单放了回去），或者见过清单之后它又不见了，
  该委托方名下所有授权书都会变成 `revocation-unavailable`：失败时关闭，而不是当作"没撤销"。从没发布过清单的委托方是
  `none-published`，这不算错误。
- 想清空清单，就发布一份 `issued` 更高的空清单。不要删除文件。
- 线程里的授权书从未被应用时（线程还在 `Offered` 或 `Accepted`），撤销没有授权书哈希可对，只能按日期生效（`revokedBefore`
  大于 0）。核验一张被拒的授权书时查到的撤销不算数。

## 问题码与错误码

核验把问题写进 `problems[].code`；只有调用写错、或者读链失败时才会抛出异常。对方造成的失败是一条问题，绝不是异常；节点
出故障是异常，绝不会变成结论。

| 问题码 | 出现在 | 含义 |
|---|---|---|
| `phase0-no-funds`、`subdelegate-not-allowed` | 授权书 | 有上限、报酬上限或代币不为零，或者开了转委托。 |
| `mandate-too-long` | 授权书 | `expires` 比 `notBefore` 晚了 30 天以上。 |
| `mandate-not-yet`、`mandate-expired` | 授权书 | 核验那一刻不在有效期内。在线程里改为按交付时间检查。 |
| `agent-key-mismatch`、`agent-mismatch` | 授权书 | 写的钥匙不是代理公布的那一把，或者写的是别的代理。 |
| `not-signed-by-holder` | 持有人消息 | 不是委托方电路的当前持有人签的。 |
| `nonce-reused` | 授权书 | 本 kit 的 nonce 存储里，同一条链、同一委托方、同一 nonce 已经对应了另一张授权书。 |
| `mandate-revoked`、`revocation-unavailable` | 授权书 | 已撤销（由 `verifyMandate` 报告，线程里不报）；或者委托方的撤销清单靠不住。 |
| `not-a-container`、`wrong-chain`、`not-tapeout`、`no-such-token` | 身份 | 该地址不是本链上 #ID 存在的 TapeOut 容器。 |
| `mandate-mismatch` | 线程 | 授权书的委托方、任务、mode 或 nonce 与报价不同，或者交付指向了别的授权书。 |
| `task-hash-mismatch`、`offer-mismatch`、`offer-expired` | 线程 | 任务原文不对、accept 指向的报价不对，或者在报价的 `exp` 之后才接单。 |
| `out-of-order`、`message-malformed`、`kind-unknown`、`kind-not-implemented`、`thread-empty` | 线程 | 消息位置不对、形状不对，或者是这一版没有实现的类型。 |
| `not-signed-by-agent`、`agent-unresolvable` | 线程 | 代理消息不是它公布的签名者签的，或者代理解析不出来。 |
| `deliver-after-deadline`、`deliver-outside-mandate`、`deliver-before-accept`、`message-after-revocation` | 线程 | 交付或代理消息的时间不对。第一条只报告，交付照样记录。 |
| `verdict-mismatch`、`verdict-before-delivery`、`revocation-mismatch` | 线程 | 验收指向的是别的交付或早于交付，或者撤销没有覆盖这个线程。 |
| `receipt-not-hash-only`、`receipt-repeated`、`receipt-provider-out-of-scope`、`receipt-outside-mandate`、`receipt-invalid`、`receipts-hash-mismatch`、`provider-unresolvable`、`evidence-malformed` | 证据 | 回执不是只含哈希的形态、重复、来自授权范围外的服务、不在有效期内、签名不对，或者整包与其哈希对不上。 |

抛出的错误（`TapeAPIError`，细节在 `data` 里）：

| 错误码 | 什么时候 |
|---|---|
| `AGENT_INVALID` | `mandateTypedData` 或 `signMandate` 拒绝写了金额、资产或转委托的授权书（`data.reason` 为 `phase0-no-funds` 或 `subdelegate-not-allowed`）；`forWallet` 拒绝载荷；任务原文与哈希对不上；字段形状不对；交给 `identityOf` 的地址不是容器（`data.reason` 为对应的问题码）。 |
| `INVALID_ARGUMENT` | 核验需要至少两家运营方的节点而客户端不够，或者没有 `rpcUrls`；`nonces` 既不是 `Map` 也不是 `setIfAbsent` 存储；付款构造被拒（`data.reason` 为 `recipient-not-from-chain`、`no-such-token`、`not-tapeout`、`only-transfer`、`native-via-container-unverifiable`）；`revocationFileBytes` 收到超过 4,096 字节的清单或形状不对的签名。 |
| `NOT_FOUND` | `readMessage` 收到一个不存在的收件箱序号。 |

## 限制

- **没有强制执行。** 授权书拦不住代理或上游服务做任何事。它是一份可核验的委托记录，不是门禁。
- **核验看的是当前持有人。** 电路转手之后，前任持有人签过的消息都不再通过，旧线程也一样；TAP-11 的委托同理。上游服务
  换了签名者之后，它以前的回执也会核验失败。
- **撤销只约束读到它的人。** 消息只约束收件人；站点清单要花一笔交易。
- **撤销只影响在它之后签名的东西。** 一条在撤销之前已经交付并验收的线程，在持有人把它的授权书列进清单之后再核验，
  仍然是 `Settled`；只有签名晚于撤销 `issued` 的代理消息会被拒。（1.7.1 之前，站点清单会把这样的线程改成 `Cancelled`
  并报 `mandate-revoked`。）时间都是签名者自己声称的：代理的 `ts` 和持有人的 `issued` 不与链上核对。
  `verifyTaskThread(messages, { readSite: false })` 可以不读清单地核验一条线程。
- **nonce 重用只有保存 nonce 存储的一方看得到**，而且前提是委托方每份报价都用新的 nonce。
- **没有仲裁。** 委托方可以拒收，也可以一直不回应；代理只能保留证据（`unaccepted`）。
- **自雇只能标出，不能阻止。**
- **钱包里看不到任务原文。** 钱包显示授权书的十二个字段和授权范围，`taskHash` 只是 32 字节。支持
  `eth_signTypedData_v4` 的钱包会逐字段显示；具体钱包怎么呈现，没有实测过。签惯了金额永远为零的授权书，人容易养成
  直接点确认的习惯；控制台提示和零地址代币就是为此而设。
- **验收和撤销不会过期。** 它们只带 `issued`，用于排序。
- **付款核验需要老区块的数据。** 它要读转账所在区块的回执；如果公共节点将来不再提供老回执，事隔很久的核验就会是
  `unavailable`。
- **我们对 TAP-10 §19 第 14 步的解读。** 如果在转账之后、本条消息之前，有一条给同一收件人的早先消息本身是经合约写入
  的（`indirect`），核验会跳过它：它的发件容器已经比对过，而它没有发件钱包可比。我们把这一步里"无法判定钱包"理解为
  TAP-10 §18.5 第 1 步失败，§18.5 与 §19 都把这种情况和 `indirect` 分开。这是我们对 TAP-10 的解读，已提请编辑确认。
  留下的口子是：付款方如果先经合约给同一收件人发过别的消息，能抓到的是它的容器，而不是它的钱包。

## 接下来

阶段 0 之后的东西都还没有做。Idea [#40](https://github.com/TapeOutProtocol/TAPs/issues/40) 设想了另外两个阶段：

- **阶段 1：支付通道。** 委托方为每个服务开一条通道并充值，把代理的钥匙授权为这条通道的会话钥匙，于是通道余额就是
  上限，会话到期时间就是时限。它建立在 Idea #38 的付款凭证设计（TapeAPI 实验性的 TAPI-22）之上，而那份托管合约尚未
  部署，也没有经过第三方审计。#40 也直说了：即便到那时，会话钥匙也撤销不了，只能等它过期。
- **阶段 2：花费金库。** 一份新的、不可升级的合约，存放押金，让代理的钥匙在单次与总额上限内调用白名单里的目标，并且
  可以立即撤销。部署之前需要新合约和独立审计。

授权书里已经留好了这些阶段要用的字段（`scope[].token`、`scope[].cap`、`feeToken`、`feeCap`、`subdelegate`），这样以后
的阶段不必更改类型、让已签的授权书作废。阶段 0 里它们必须保持为零；SDK 对写了金额的授权书给出的控制台警告也说明了原因：
以后的阶段可能把它当作花费授权。格式仍可能随 #40 与 #41 的讨论而变化。
