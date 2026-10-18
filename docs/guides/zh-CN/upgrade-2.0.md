# 从 1.x 升级到 2.0

TapeAPI 2.0.0 于 2026-10-12 发布。本页列出它的破坏性修改，以及改成什么写法；这里没有列出的，在 2.0 里与 1.x 一样工作。
2.0.0 发布后，1.x 继续获得 6 个月的安全修复。

## 2.0 保留什么

1.0 承诺的三个等级不变：**Stable（稳定）**（2.x 之内没有破坏性修改；新增内容可以出现在任何次版本里）、
**Experimental（实验性）**（`@experimental`，可能在次版本里改变，每次修改都写进更新日志）与 **Internal（内部）**。
破坏性修改只出现在新的大版本里。TAPI-20 至 TAPI-27 的线路格式与冻结常量不变：2.0 客户端照样核验 1.x 的每份清单、委托、
签名响应与回执，以及它们的向量；需要时也仍能使用第 1 版的私密通道与私密群聊（见下文）。

有一点性质不同：2.0 的默认按 TAP-10 与 TAP-11 解析，它们是合并为 Draft 的（合并不等于被采纳），文本还可能改。默认怎样跟随这些文本的变化，
以及 `data.status`、`SiteStatus` 与 `svc.conform` 为什么在 2.0 里仍是实验性，见下文"默认如何跟随官方 TAP 的变化"。

## 破坏性修改

在代码里搜索第一列的名字。

| 1.x | 2.0 | 原因 |
|---|---|---|
| 私密通道与私密群聊使用标签 `TAP-26/…`、`TAP-27/…`（TAPI-26、TAPI-27 第 1 版），除非传 `labels: 'v2'` | 使用标签 `tape-channel/…`、`tape-group/…`（[TAPI-26 v2](../../../spec/TAPI-26-v2.md)、[TAPI-27 v2](../../../spec/TAPI-27-v2.md)），除非传 `labels: 'v1'` | TapeOutProtocol/TAPs 的编辑要求在合并私密通道与私密群聊草稿之前，标签不要看起来像 TAP 编号。标签在 Stable (v1) 规范里是冻结的，所以改名作为两份规范各自的第 2 版。1.8.1 把它作为选项加入，2.0 把它改为默认。见下文"通道与群聊"。 |
| `e.tooLarge`、`e.rpcCode`、`e.rpcRevert`、`e.rpcData`、`e.agreed`、`e.disagreed`、`e.failed`、`e.groups`、`e.quorum`、`e.reason`、`e.refusals`、`e.effectiveK`…… | `e.data.tooLarge`、`e.data.rpcCode`…… | `TapeAPIError` 的顶层字段自 1.0 起固定（`name`、`code`、`message`、`data`、`signed`、`httpStatus`、`cause`，签名的提供者错误另有 `ts`、`block`、`id`、`sig`、`error`），其余细节都在 `data` 里。1.x 还把旧名字留作只读的弃用别名。2.0 删除了这些别名：读取它们得到 `undefined`。 |
| 传给通道模块（`channel.*`，TAPI-26）的选项或参数有误，报 `CHANNEL_INVALID` | `INVALID_ARGUMENT` | 这是其它模块自 1.0 起都遵守的规则：用一个错误码表示"你自己的选项或参数有误"，在发出任何东西之前报出，重试毫无意义。出错的 TAPI-26 数据仍报 `CHANNEL_INVALID`。见下表。 |
| `createTapeAPI()` 不传 `conform` 时按 TapeAPI 自己的办法解析；`conform: 'tap10'`（实验性）才按 TAP-10 与 TAP-11 的规定解析 | 不传 `conform` 就按 TAP-10 / TAP-11 §2 的规定解析；`conform: false` 是 1.x 的行为（已弃用，整个 2.x 内保留） | 名字如何解析，官方 TAP 已有规定；2.0 默认遵循它们，除非你选择退出。见下文"一致模式成为默认"。 |

### 一致模式成为默认

1.x 中，`createTapeAPI()` 按 TapeAPI 自己的办法解析名字，只有传 `conform: 'tap10'`（1.4 起的实验性选项，见
[一致模式](upgrade-1.0.md)）才按 TAP-10 / TAP-11 的规定解析。2.0 把后者改为默认：

```js
// 1.x：TapeAPI 自己的办法
const api = createTapeAPI({ rpcUrls })
// 2.0：这就是 TAP-10 / TAP-11 §2 的解析，与 1.x 里的 conform: 'tap10' 完全一样
const api = createTapeAPI({ rpcUrls })
// 2.0：1.x 的行为，逐个请求都不变（已弃用；整个 2.x 内保留）
const api = createTapeAPI({ rpcUrls, conform: false })
```

不传 `conform`，客户端按 TAP-10 v1.1 §3 至 §7 与 TAP-11 §2 的规定解析，全部读取钉在一个 TAP-10 钉块上。传 `conform: false`
（或 `null`）就回到 1.x 的默认行为。有一个测试固定住：`conform: false` 发出的请求、顺序与结果和 1.8 的默认逐一相同，除了 `chain.channelKeys` 报告的 v2 收件房间（标签默认，见"通道与群聊"）和弃用警告。
`conform: false` 已弃用：每个这样建立的客户端在建立时通过 `onWarning` 报告一次警告（不抛错，也不改变任何行为；SDK 内部建的客户端，如 `forChain` 返回的，不重复报告），2.x 内保留。
3.0 是否删除尚未决定。

不变的：`allChains` 仍默认关闭（打开它会把查询发给其它链的公共节点），`sentinel` 仍是 `'warn'`，`siteStatus` 在两种模式下本来就一样，
代理工具包本来就按 TAP-11 §2 解析。

| | 1.x 默认 | 2.0 默认 | 2.0 `conform: false` |
|---|---|---|---|
| 用哪种解析 | TapeAPI 自己的（TAPI-20） | TAP-10 §3 至 §7 与 TAP-11 §2 | 1.x 的解析，不变 |
| 读取所用的区块 | 最新块，不钉块（`pin` 需自己开启） | 一个 TAP-10 钉块，按块号与哈希确认 | 最新块，不钉块 |
| 节点的共识 | 法定数量（quorum）：多数运营方一致 | `eth_chainId`、`ownerOf` 与合约持有人的 EIP-1271 调用用严格共识：每家运营方都要作答并且一致；其余用法定数量 | 法定数量 |
| 从未开通的名字 | 清单有效即解析成功 | `SITE_STATUS`，`data.status: 'not-opened'` | 解析成功 |
| 未激活或付费已到期的名字 | 解析成功 | `SITE_STATUS`，`data.status: 'unpaid'` | 解析成功 |
| TapeOut 升级了站点存储或付费合约 | 解析成功（`sentinel: 'warn'` 只警告） | `CONTRACT_UNKNOWN`，`data.status: 'store-changed'`，直到 SDK 收录新实现 | 解析成功并带警告 |
| 不含链信息的输入（容器地址、处理器合约#ID） | 在本客户端的链上查找 | 本客户端链上的容器地址字符串照常解析（不需要 `allChains`）。"处理器合约#ID"字符串一律 `INVALID_ARGUMENT`，`data.status: 'unsupported'`，除非 `allChains: true`；不是本链容器的容器地址字符串也是（它可能是别的链上的容器：1.x 报 `MANIFEST_INVALID`，开了 `allChains` 的一致客户端读遍所有链之后才报 `not-tapeout`）。见下文"已知例外" | 同 1.x |
| 目录标签 | 传了 `directory` 即可解析 | 拒收（TAP-10 §3.4） | 可解析 |
| 自定义 `hub`、`factory`、`siteRegistry`，本地链或 fork，显式 `pin` | 允许 | 创建客户端时 `INVALID_ARGUMENT`，提示 `conform: false` | 允许 |
| 错误的细节 | `code` | `code` 与 `data.status`（TAP 里的小写名） | `code` |
| 清单缓存多久 | 3,600 秒 | 60 秒 | 3,600 秒 |
| 一次冷解析的请求数 | 约 24 次（BNB Smart Chain） | 约 45 次 | 约 24 次 |

最后一行的含义见下文"请求量增加多少"。

#### 新出现的失败

下面每一种在 1.x 里都能解析成功。请按 `e.data.status` 分支，不要按错误信息分支：状态名是各 TAP 使用的小写名（`unsupported`、`hub-changed` 与 `container-mismatch` 是 TapeAPI 自己的名字）。状态名只增不改：
一个名字不会被改名或删除；新增的名字在次版本里出现；已有名字的判定条件的收紧，先以可选 profile 提供。见下文"默认如何跟随官方 TAP 的变化"。

| `e.data.status` | `e.code` | 发生了什么 | 怎么办 |
|---|---|---|---|
| `not-opened` | `SITE_STATUS` | 名字存在，但它的容器从未开通（TAP-10 §6.2） | 只有持有人能改变：开通容器。不要重试。 |
| `unpaid` | `SITE_STATUS` | 名字未激活，或付费已到期（TAP-10 §6.3） | 只有持有人能改变：用 `DomainBinding.bind` 激活并付费。不要重试。 |
| `store-changed` | `CONTRACT_UNKNOWN` | SiteRegistry 或 DomainBinding 运行着本 SDK 没有收录的实现。失败关闭。 | 升级 `@tapeapi/sdk`。补丁版发布之前，`conform: false` 是临时办法。 |
| `unavailable` | `RPC_UNAVAILABLE`（1.x 的 `RPC_DISAGREE` 也变成它） | 严格读取没有得到每家运营方的回答，或两家的回答不同。BNB Smart Chain 的默认节点是三家运营方，三家都要作答。报出之前，若失败的节点都只是网络故障（连接断开或被拒、DNS 失败、网关超时 504、522、524 以外的 HTTP 5xx；超时不算）、且这一轮用时不到 2 秒，SDK 会把全部节点再问至多两次，每次规则相同，多花不到 5.2 秒（实验性，`rpcRetries: 0` 关闭）。 | 重试；反复出现就在 `rpcUrls` 里加一家你自己的运营方。 |
| `manifest-invalid` | `MANIFEST_INVALID` | 链上清单以 UTF-8 字节序标记（BOM）开头，或不是合法的 UTF-8（TAP-11 §3.1、TAP-10 §16）。1.x 会照常解析这样的清单。 | 请持有人重新发布一份合法 UTF-8、不带字节序标记的清单。在那之前，`conform: false` 是临时办法。 |
| `unsupported` | `INVALID_ARGUMENT` | `allChains` 关闭，且输入没有指明链："处理器合约#ID"字符串（一律如此），或不是本客户端链上容器的容器地址字符串（它可能在别的链上，所以报 `unsupported` 而不是 `not-tapeout`）。本客户端链上的容器地址照常解析，约 75 次请求（1.x 约 21 次）。 | 指明链（`{ chainId, container }`，或带区号的名字），或设 `allChains: true`（要知道这会把读取发给其它链的公共节点）。这是与 TAP-11 §2.1 的已知例外，见下文。 |

需要提前准备的是 `store-changed`。TapeOut 一旦升级站点存储或付费合约，所有 2.x 客户端当天就会对那条链失败关闭，直到补丁版把新实现
加入接受列表（只改 `chains.js`，别处不变）。这是不信任一份没人审过的合约的代价；补丁发布之前，`conform: false` 是继续工作的办法。

1.x 的 `conform: 'tap10'` 里已有的其它状态不变：`no-such-cpu`、`no-such-token`、`not-tapeout`、`stale-block`、`wrong-chain`、
`ambiguous`、`no-manifest`、`manifest-invalid`、`delegation-invalid`。消息读取也一并跟随：`chain.channelKeys` 报 `store-changed`
并拒收字节序标记；`chain.tapeSendKey` 报 `hub-changed`、`circuits-changed`、`hub-mismatch`、`no-key` 与 `key-stale`。两者都不检查激活
（TAP-10 §12.2：付费不得阻止消息）。

```js
try {
  svc = await api.resolve('11.1013.tape')
} catch (e) {
  switch (e.data?.status) {
    case 'not-opened': case 'unpaid': /* 服务方要处理：告诉用户，不要重试 */ break
    case 'store-changed':             /* 升级 SDK，或在能升级之前用 conform: false */ break
    case 'unavailable':               /* 节点问题：重试 */ break
    default: throw e
  }
}
```

#### 已知例外：不开 `allChains` 时的"处理器合约#ID"（TAP-11 §2.1）

TAP-11 §2.1 规定客户端 MUST 接受链上名字、容器地址，以及带 #ID 的处理器合约（TAP-10 §3.4 的文本形式或两个值）。
由于 `allChains` 默认关闭，2.0 的默认对其中一种输入形式做不到这条 MUST：

| 输入 | 2.0 默认（`allChains` 关闭） | `allChains: true` |
|---|---|---|
| "处理器合约#ID"字符串，例如 `0x50A994E71615474b55559fF4F500928fbc339DD9#4246` | 发出任何请求之前拒收：`INVALID_ARGUMENT`，`data.status: 'unsupported'` | 按 TAP-10 §4.1 解析：在每条 TapeOut 链上各自钉块读取；多条链命中即 `ambiguous`；某条链读不到时报那条链的状态，绝不猜 |
| 不是本客户端链上容器的容器地址字符串 | `INVALID_ARGUMENT`，`data.status: 'unsupported'`（本链的容器照常解析） | 在每条链上读取；读遍所有链之后才报 `not-tapeout` |
| 不带 `chainId` 的 `{ circuits, tokenId }`（两个值的形式） | 接受，只在本客户端的链上解析 | 相同：不带 `chainId` 的对象即指本客户端的链，从不搜索 |

与 TAP-11 的差异：

- TAP-11 §2.1 把接受"处理器合约#ID"形式定为 MUST；默认拒收它的字符串形式。TAP-10 §4.1 规定，无链信息的输入要读遍所有活跃链才能
  解析，也就是要向 Base 与 X Layer 的公共节点发请求。2.0 在你不明确要求时不这样做：只配了自己 BNB Smart Chain 节点的客户端，
  绝不向别的链的节点发请求。
- `unsupported` 是 TapeAPI 自己的名字，不是 TAP-11 §2.3 或 TAP-10 §6.4 的结果名，也不是对输入的结论：它只说明本客户端没有读别的链。
  符合 TAP 的客户端会给出解析结果、`ambiguous`、读不到的那条链的状态，或 `not-tapeout`。
- 对两个值的形式，TAP-10 §4.1 同样要求读遍所有链；SDK 把缺少的 `chainId` 当作本客户端的链，`allChains` 开或关都一样。

要按 TAP-11 §2.1 解析这些输入：建客户端时传 `allChains: true`（它会同时读取 Base 与 X Layer，经 `chains[id].rpcUrls` 或 SDK 为这两条链
提供的默认节点），并传字符串形式。或者自己指明链：带区号的名字、`{ chainId, container }`，或 `{ circuits, tokenId, chainId }`。

2.0 让 `allChains` 保持关闭；这个例外没有被消除，而是记录在这里。

#### 错误码本身改变

有些失败在 1.x 里也是失败，只是 `e.code` 不同。按 `e.code` 分支的调用方会看到变化；（仅默认模式的）`e.data.status` 则保持稳定。下面是两侧都失败、
而错误码本身不同的全部情形，由同一批用例分别经 `conform: false` 与默认运行比较得出（共 637 个用例的差分运行）：

| 1.x（`conform: false`） | 2.0 默认 | 何时 |
|---|---|---|
| `MANIFEST_INVALID` | `NOT_FOUND`，`data.status: 'no-such-token'` | 令牌没有持有人（`ownerOf` 回滚），例如没人铸造过的 #ID |
| `MANIFEST_INVALID` | `NOT_FOUND`，`data.status: 'not-tapeout'` | 不是 TapeOut 容器的容器地址（在它可能所在的每条链上读过） |
| `MANIFEST_INVALID` | `INVALID_ARGUMENT`，`data.status: 'input-error'` | TAP-10 §3.4 不接受的输入，例如 `04246.7`（前导零） |
| `MANIFEST_INVALID` | `INVALID_ARGUMENT`，`data.status: 'unsupported'` | 把别的链的容器地址交给本链的客户端：`api.forChain(8453).resolve(容器)`，容器在 BNB Smart Chain 上 |
| `RPC_DISAGREE` | `RPC_UNAVAILABLE`，`data.status: 'unavailable'` | 严格读取时各运营方的回答不同 |
| `chain.channelKeys`：`RPC_ERROR` | `NOT_FOUND`，`data.status: 'no-such-token'` | 容器的令牌没有持有人 |
| 把目录标签交给 `resolve`：`MANIFEST_INVALID` | `INVALID_ARGUMENT`，`data.status: 'input-error'` | 标签不再是输入（TAP-10 §3.4）；读任何东西之前就拒收 |
| 目录标签：`DELEGATION_INVALID` | `INVALID_ARGUMENT`，`data.status: 'input-error'` | 同上；这是 1.x 对某些标签报的错误码 |
| 目录标签：`NOT_FOUND` | `INVALID_ARGUMENT`，`data.status: 'input-error'` | 同上；这是 1.x 对没找到的标签报的错误码 |

只是多了 `data.status` 或只改了信息的失败，错误码不变，不在此表。1.x 里根本没有的新失败见上一张表。

#### 你的配置可能在创建客户端时就失败

不在 TAP-10 所列 TapeOut 链上的客户端无法按 TAP-10 的规定解析，所以下面这些报 `INVALID_ARGUMENT`，
信息里写明"传 `conform: false`"：

- 你自己的 `hub`、`factory`、`siteRegistry`、`opener` 或 `binding` 地址，或不在 TAP-10 所列 TapeOut 链上的
  `chainId`（本地链、anvil fork、测试部署）。对客户端自己的链，在 `createTapeAPI()` 时就报错；对 `chains[id]` 里别的链的地址，报错更晚：
  每条链的子客户端在第一次需要时才创建，所以错误来自第一次 `api.forChain(id)`（或第一个需要它的那条链上的名字），而不是
  `createTapeAPI()`。它仍然是报错、绝不静默回退；因此 `tapeapi-mcp` 对 `--rpc-xlayer` / `--rpc-base` 配错的报告，要等到它解析那条链上的名字时；
- 没传 `conform` 却传了显式的 `pin`（`'latest'`、`true`、`{ tag }` 等）：默认已经按 TAP-10 的规定钉块，两者不能同时使用。

`dev: true` 视同 `conform: false`：开发模式本来就不检查链上身份，所以照常工作。不会静默回退：同一个客户端因配置不同而按这条或那条规则解析
同一个名字，正是一致模式要杜绝的。想要 1.x 的行为，就在同一份选项里写 `conform: false`。`api.forChain()` 会把模式传给子客户端，
所以默认客户端的子客户端也是一致的。

#### 命令行

`tapeapi-mcp`、`tapeapi-verify` 与 `tapeapi-doctor` 跟随新默认，并在输出里写明所用的模式。`tapeapi-doctor` 在报告里写明，`tapeapi-verify` 打印一行 `resolution:`。三者都有 `--no-conform`（等同于
`conform: false`）来取得 1.x 的行为。`tapeapi-doctor` 本来就检查名字是否已开通、已激活；变的是结论：默认模式下，名字未激活是医生
激活检查的**失败**（默认客户端不解析它，医生不能说它没问题）；用 `--no-conform` 时仍只是警告。

#### 如果你提供服务

在 2.0 下，客户端看不到你的名字已开通且已付费，就会得到 `not-opened` 或 `unpaid`，不会解析它，哪怕你的服务应答完全正常。
在你的客户端升级之前先检查：

1. 名字已 `bind` 并已激活，付费不会很快到期。`tapeapi-doctor <你的名字>` 两项都查，并打印剩余天数（默认模式下，名字未激活它会报失败）。
2. 容器已开通（TAP-10 §6.2）。
3. 清单与委托像以前一样有效。它们没有任何改变。

用 2.0 的安装运行 `tapeapi-doctor <你的名字>`。前 7 项（`name` 至 `delegation`）通过，2.0 的客户端就能解析你。之后各项是针对
AI 服务的：不是 AI 服务的会在 `ai-field` 失败、其余跳过，与 1.x 相同。

旧回执同样适用这条规则。付费一旦到期，2.0 的客户端就解析不了你的名字（`unpaid`），所以你的服务在付费期内签出的**历史回执**它也核验不了：
[回执核验页](https://tapeapi.fun/verify/)会说"没能核对"，而不是"有效"。这个页面回答的问题，从"这份回执签出时有效吗？"变成"签出它的服务现在付着费吗？"。
只要还有人可能要核验你签过的东西，就让服务一直保持付费；或者用 `conform: false` 的客户端（1.x 的解析，不看付费）核验旧回执。

#### 请求量增加多少

一致解析要多读一些：钉块（按块号与哈希确认）、`eth_chainId`、开通器、DomainBinding、站点存储与付费合约的实现槽，以及严格共识下的
`ownerOf`。在 BNB Smart Chain 上用默认节点实测（全新客户端解析一个有效服务，统计它发出的 JSON-RPC 调用）：`conform: false` 约 24 次，
默认约 45 次，冷解析大约是 2 倍；同一客户端再解析一次，分别约 9 次与约 36 次，大约 4 倍。早先在测试链上的粗测是冷解析约 3 至 6 倍的请求；
请按 2 至 6 倍来规划。清单也只缓存 60 秒而不是 3,600 秒，长连接客户端重读清单的频率约为原来的 60 倍。如果某个公共节点开始限流，
先在 `rpcUrls` 里加你自己的运营方，再考虑 `conform: false`。

#### 依据哪一版文本：`CONFORM_PROFILE`

2.0 新增 `CONFORM_PROFILE`（从 `@tapeapi/sdk` 导出），并在一致模式解析出的每个服务上新增 `svc.conform.profile`。两者都写明本模式
依据哪一版文本解析。2.0 中的值是 `'tap10@1.1+tap11@draft'`：TAP-10 按它的 `version: 1.1`（每个 TAP-10 结果本来就带的 `version`），
TAP-11 尚无版本号、处于 Draft。

```js
import { createTapeAPI, CONFORM_PROFILE } from '@tapeapi/sdk'
const svc = await createTapeAPI({ rpcUrls }).resolve('11.1013.tape')
svc.conform.profile === CONFORM_PROFILE   // 'tap10@1.1+tap11@draft'
```

它只是新增：已有的字段、状态名、请求与错误都不变。`conform: false` 没有 `svc.conform`，也就没有它；`api.siteStatus()`（保留它的
`version`）与错误的 `data` 都不带它。一个值的含义永不改变：跟随了改动后 TAP 文本的 SDK 会用另一个值表明，所以保存结果时把它一起存下。
与 `svc.conform` 的其余部分一样，它标为 `@experimental`。

#### 默认如何跟随官方 TAP 的变化

TAP-10 与 TAP-11 是合并为 Draft 的（合并不等于被采纳），2.0 之后它们的文本仍可能改。默认按 `CONFORM_PROFILE` 所写的文本解析。
这份文本变了，默认按下面的规则跟随：

| 文本的变化 | 默认何时跟随 | 你会看到什么 |
|---|---|---|
| **放宽**一条规则：原来被拒收的输入形式现在接受，或原来失败的情形现在能解析 | 在 2.x 的次版本里，直接成为默认 | 另一个 `CONFORM_PROFILE` 值，和一条更新日志 |
| **新增**一个状态名 | 在 2.x 的次版本里，直接成为默认 | 出现新名字；已有的名字不变 |
| **收紧**一条规则：原来能解析的输入现在失败，或改变已有状态名的判定条件 | 不在 2.x 的默认里。先作为可选的新 profile 提供，默认到 3.0 才切换 | 一条更新日志，写明怎样选用新 profile；默认的行为照旧 |

对你的代码意味着：

- 状态名只增不改（与 TAP-11 §2.3 一致）：一个名字不会被改名或删除。按 `e.data.status` 分支时保留一个 `default:` 分支，如上面的示例；
  不认识的名字是一种新结果，不是崩溃。
- 放宽可能让你原来处理的失败变成成功。依赖那个失败的代码会看到另一种结果。
- 第一次收紧出现之前，只有一个 profile，即 `CONFORM_PROFILE` 的值，没有选项可以选另一个。加入新 profile 的那个版本会在更新日志里写明怎样选用。
- `conform: false` 是 1.x 的解析，完全不跟随 TAP。

`data.status`、`SiteStatus` 与 `svc.conform` 在 2.0 里仍标为 `@experimental`，因为它们跟随的文本还是 Draft。上面的规则是 TapeAPI 的做法；
标签说明它还不是"2.x 之内没有破坏性修改"的 Stable 承诺。待 TAP-11 的评审期结束且没有未解决的异议之后，才会考虑把它们升为 Stable，不会早于那时。

### 通道与群聊

TapeAPI 1.x 默认使用 TAPI-26 与 TAPI-27 第 1 版；1.8.1 及以后的 1.x 传 `labels: 'v2'` 时使用第 2 版。TapeAPI 2.0 默认使用
第 2 版，传 `labels: 'v1'` 时使用第 1 版。两个版本不互通：收件房间、通道房间、群房间、每把密钥与每个签名都依赖标签。不会出现
"错误地放行"：另一个版本的邀请或消息要么根本看不到，要么被拒收（SDK 能看出时带 `e.data.labels` 与 `e.data.peerLabels`），
所以版本不一致的两端得到的是超时或明确的版本不一致错误，而不是错误的结果。

按通信对象分别处理：

- **双方都是 2.0，或都是 1.8.1 以后并传了 `labels: 'v2'`**：无需改动。`labels: 'v2'` 现在就是默认，可以删掉。
- **对端或群仍在 1.x、没有传 `labels: 'v2'`**：在你这一方传 `labels: 'v1'`，涉及 `createInvite`、`acceptInvite`、`roomsFor`、
  `inboxRoom`、`sealInvite` / `openInvite`、`sealToInbox` / `openFromInbox`、`createGroup`、`joinGroup`、`checkGroupInvites`、
  `openGroupInvite` 与 `groupRoom`，直到对方升级或改用第 2 版。`labels: 'v1'` 在 2.x 内已弃用，2.x 内不删除。
- **核对实际得到的版本**：`pending.labels`、`session.labels` 与 `group.labels` 说明句柄所用的版本。

哪些延续、哪些不延续：

- 一个通道会话从握手到最后一帧都保持握手时的版本。升级之后的新握手使用新的默认值；要继续使用第 1 版，请传 `labels: 'v1'`。
- 一个群终生保持其版本。1.x 群主的快照（`v: 1` 或 `v: 2`）是第 1 版的群，在 2.0 里也按第 1 版恢复：群主升级不会改变它，
  成员继续给 `joinGroup` 与 `checkGroupInvites` 传 `labels: 'v1'`。要把群改成第 2 版，群主新建一个群（第 2 版的快照写为 `v: 3`）。
- `api.chain.channelKeys(...).inbox.room` 是默认版本的收件房间：2.0 中是第 2 版的房间（1.x 中是第 1 版的）。第 1 版的房间是
  `channel.inboxRoom(container, chainId, { labels: 'v1' })`。
- 通道记录（`.well-known/tape-channel.json`、`ChannelKeys`）不含标签，仍然有效。持有人无需重新签名。
- 中继（`relay.tapeapi.fun`）与 ChannelBus 只搬运字节，不需要改动；它们同时服务两个版本。
- TAPI-26 与 TAPI-27 第 1 版仍是 Stable (v1)，最早在第 2 版进入 Stable 满 12 个月后才会撤回（TAPI-1 §4.1）。TapeAPI 1.x 仍以
  第 1 版为默认，2.0.0 发布后 1.x 对它的安全修复维护 6 个月。

### 哪些通道错误现在是 `INVALID_ARGUMENT`

| 位置 | 1.x 的错误码 |
|---|---|
| `createInvite`：没有 `self` 或 `peer`，`self` 或 `peer` 的容器不是地址，`self.staticSecret` 不是 32 字节，`ttlS`、`keys`，你自己给的 `relays` 或 `bus` | `CHANNEL_INVALID` |
| `acceptInvite`：没有 `self` 或 `peer`，它们的容器，`self.staticSecret`，`seen` 不是 `Set` | `CHANNEL_INVALID` |
| `completeInvite` 传入待定句柄的副本或已经用过的句柄；在发起方的会话上 `confirm`；`close()` 之后 `seal`、`seal` 的不是字符串或字节、或超过 16,384 字节；`close()` 之后 `open`；`encodeWire` 的不是帧、`accept` 或 `ready` | `CHANNEL_INVALID` |
| `relayTransport` 没有 `api` 或 `service`，或 `inbound` / `outbound` 不是房间号 | `CHANNEL_INVALID` |
| `busTransport` / `busReader`：`rpc` 客户端、`bus`、房间、`fromBlock`、`confirmations`、`lookback`、`overlap`、`chunk`、`minChunk`、`budgetMs`、`verdictMs`、`startGraceMs`、`blockBodyLimit`、`warn`，处理函数不是函数，`sendMany` 给了 0 条或过多的线路消息，线路消息超过总线上限，没有 `sendTx` 就 `send` | `CHANNEL_INVALID` |
| `fanIn`：没有传输，传输缺少 `send` / `poll` / `start` / `stop`，`window`，向不存在的传输序号 `send` | `CHANNEL_INVALID` |
| `sealToInbox`：`to.container` 不是地址，内容过大无法密封；`openFromInbox`：`self.staticSecret`、`self.container`（两个 `labels` 版本下都一样） | `CHANNEL_INVALID` |

`labels` 不是 `'v1'` 或 `'v2'` 时，1.8.1 已经报 `INVALID_ARGUMENT`，现在照旧。

仍报 `CHANNEL_INVALID` 的：一切关于 TAPI-26 数据的错误，无论数据来自网络还是来自你：邀请、`accept` 或 `ready` 消息、帧、
密封邀请（包括按另一标签版本密封的）、线路消息，对方或收件方的长期公钥不是可用的 X25519 公钥，从邀请里读出的中继列表或总线，
过期或重放的邀请，以及直接调用共用校验函数 `checkRelays`、`checkBus`、`assertPublicKey`、`assertEd25519Public`、`endpointBytes`
与 `inboxRoom`。`fanIn` 的所有传输都失败时，错误仍是 `CHANNEL_INVALID`。

2.0 中不变的：群聊模块（`group.*`，TAPI-27）对调用方的错误仍报 `GROUP_INVALID`；`api.call()` 在发送前对 `params` 与 `id`
的检查仍报 `BAD_REQUEST`。

### 不需要改的代码

`channel.relayTransport({ api, service })` 自 1.0 起就接受 `service`，并且仍拒绝 `svc`。2.0 中通道的实现本身也用这个名字，
包里不再做转换；使用公开的 `@tapeapi/sdk/channel` 的代码看不出任何区别。

## 2.0 中还没有的

计划放进 2.0 的其它修改（提高 Node.js 版本下限，可能还有 `parseUnits` / `formatUnits` 必须给小数位、`verifyUsageReceipt` 的默认新鲜度窗口）
尚未进行。在此之前，以 [从 0.x 升级到 1.0](upgrade-1.0.md) 所述的 1.x 行为为准。
