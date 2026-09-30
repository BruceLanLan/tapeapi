# defi-portfolio-read — TAPI-23 多链组合读取 / TAPI-23 multi-chain portfolio reads

> 中文在前，English below in each section.

## 这是什么 / What this is

**中文**：TAPI-23 §3.1 `attestedRead` 方法档案的**领域特化**。不是通用的 `read(chainId, call)`（那是
`examples/chain-attested-read/` 的活），而是把「某个地址在某条链上持有什么」做成四个具体方法：原生币与
ERC-20 余额、跨链组合、UniswapV2/PancakeV2 的 LP 份额、PancakeSwap V3 的 NFT 仓位。
**每条链各自锚定一个区块**，默认 `finalized`，一律按 EIP-1898 的 `{ blockHash, requireCanonical: true }` 求值，
整个 `result` 由提供者按 TAPI-21 签名。

本示例真正想讲的不是「怎么查余额」，而是 **TAPI-23 §3.4 的五步法定人数模式**——见下面那一节，那是主戏。

**EN**: A domain specialisation of the TAPI-23 §3.1 `attestedRead` method profile. Rather than a generic
`read(chainId, call)` (that is `examples/chain-attested-read/`'s job), it turns "what does this address hold on
this chain" into four concrete methods: native and ERC-20 balances, a cross-chain portfolio, a
UniswapV2/PancakeV2 LP share, and PancakeSwap V3 NFT positions. **Each chain is pinned to its own block**,
`finalized` by default, always evaluated at the EIP-1898 block object `{ blockHash, requireCanonical: true }`,
with the whole `result` signed by the provider under TAPI-21.

The real subject of this example is not balance lookup — it is **the five-step quorum pattern of TAPI-23 §3.4**,
which has its own section below and is the main event.

---

## 跑起来（三步）/ Run it (3 steps)

**中文**

```sh
# 1) 起服务（dev 模式，所有方法免费）
cd <repo>/tapeapi
FREE_ALL=1 node examples/defi-portfolio-read/index.mjs
# [portfolio] DeFi Portfolio Read (TAPI-23 multi-chain) listening on http://127.0.0.1:8795

# 2) 问一次（免费方法，无需 voucher）
curl -s -X POST http://127.0.0.1:8795/tapeapi/v1/balances -H 'content-type: application/json' \
  -d '{"id":"b-1","params":{"chainId":56,"address":"0xF977814e90dA44bFA03b6295A0616a897441aceC",
       "tokens":["0x55d398326f99059fF775485246999027B3197955"]}}' | jq .

# 3) 跑单测（不联网）
node --test "examples/defi-portfolio-read/*.test.mjs"
```

`PORT=0` 会让内核分配端口，实际端口打印在启动日志里。

**EN**: (1) start the server with `FREE_ALL=1` so every method is free in dev; (2) POST to any method — free
methods need no voucher; (3) run the unit tests, which never open a socket. `PORT=0` lets the kernel pick a
port; the real one is printed in the startup log.

---

## 方法表 / Methods

| 方法 / method | 价格 / priceBEM | quorum | 说明 / what it does |
|---|---|---|---|
| `balances` | 0.0002 | **`[quorum]`** | 一条链上的原生币 + ERC-20 余额，锚定一个块。接受显式 `block`，永远返回钉住的块。<br>Native + ERC-20 balances on one chain, pinned. Accepts an explicit `block` and always returns the pinned block. |
| `portfolio` | 0.001 | **`[no-quorum]`**（顶层）<br>每个 `chains[i]` 各自 `[quorum]` | 多条链，每条各自锚定一个块。顶层没有单一区块。<br>Several chains, each pinned independently. There is no single block at the top level.<br>**不要把它放进 `callQuorum`，会必然 `QUORUM_FAILED`。**<br>**Do not put this in `callQuorum`; it will always `QUORUM_FAILED`.** |
| `lpV2` | 0.0002 | **`[quorum]`** | UniswapV2/PancakeV2 的 LP 仓位：占储备的份额。接受显式 `block`，永远返回钉住的块。<br>A V2 LP position: share of the reserves. Accepts an explicit `block` and always returns the pinned block. |
| `lpV3` | 0.0004 | **`[quorum]`** | PancakeSwap V3 的 NFT 仓位（仅 chainId 56）。接受显式 `block`，永远返回钉住的块。<br>PancakeSwap V3 NFT positions (chainId 56 only). Accepts an explicit `block` and always returns the pinned block. |

**中文**：`portfolio` 之所以是 `[no-quorum]`，不是因为它不确定，而是因为**顶层没有一个可比的块**：三条链
各自钉各自的 `finalized`，两家提供者不可能同时落在同样的三个块上。要 quorum，就**对每条链分别调
`balances`**，把该链的显式块号发给每一家。每个 `chains[i]` 本身是完全锚定的，拆开来就能进 quorum。

**EN**: `portfolio` is `[no-quorum]` not because it is non-deterministic but because **there is no single
comparable block at the top level**: three chains each pin their own `finalized`, and two providers will not
land on the same three blocks at the same instant. For a quorum, call `balances` **per chain** with that
chain's explicit block number. Each `chains[i]` entry is itself fully pinned, so it quorums fine once split out.

`lpV3` 对 `chainId !== 56` 回 `METHOD_NOT_FOUND`（TAPI-23 §3.1 要求「未列出的链」如此），而其它方法对
未配置的链回 `BAD_REQUEST`（house `chainOf()` 的约定）。这个不对称是有意的：前者是方法档案
`attestedRead.chains` 的语义，后者是服务没配那条链。
`lpV3` answers `METHOD_NOT_FOUND` for `chainId !== 56` as TAPI-23 §3.1 requires for a chain outside the
method's `attestedRead.chains`, while the other methods answer `BAD_REQUEST` for an unconfigured chain (the
house `chainOf()` convention). The asymmetry is deliberate: the first is the method profile's semantics, the
second is "this deployment does not serve that chain".

---

## 字段命名：为什么这里是扁平的 `blockNumber`，而隔壁是 `blockPinned` / Field naming

**中文**：TAPI-23 §3.3 规定通用 `read` 的 `result` **只能**有
`{ chainId, blockNumber, blockHash, stateRoot?, blockRef?, result }`，并且明文写着
*"Providers MUST NOT add other fields"*。本示例的四个方法是**领域方法而不是通用 `read`**，所以允许带自有
字段（`native`、`tokens`、`positions` …），但那四个锚定字段**必须保持 TAPI-23 的名字并且是顶层扁平的**：

```jsonc
{ "chainId": 56, "blockNumber": 123018562, "blockHash": "0xa0a2eb…", "blockRef": "hash",
  "address": "0xF977…aceC", "native": { … }, "tokens": [ … ] }
```

而兄弟示例 `defi-price-oracle` / `defi-lending-health` / `defi-twap-oracle` 用的是**包起来**的形式：

```jsonc
{ "bnbUsd": "754.12…", "blockPinned": { "blockNumber": …, "blockHash": "0x…", "blockRef": "hash" } }
```

**这是一处真实的不一致，不是笔误。** 原因：那三个示例是 **BSC 本链**的读取，`blockPinned` 是本仓库的本链
约定；本示例是 **TAPI-23 的跨链读取**，消费者会按 TAPI-23 §3.4 第 4 步逐字段比较
`chainId` / `blockNumber` / `blockHash`，字段名必须和规范一致，否则通用的 TAPI-23 客户端读不懂。
`portfolio` 的**每个 `chains[i]` 也各自带这同样四个扁平字段**——因为每条链是各自独立锚定的。

**EN**: TAPI-23 §3.3 restricts a generic `read`'s `result` to exactly
`{ chainId, blockNumber, blockHash, stateRoot?, blockRef?, result }` and states that providers MUST NOT add
other fields. The four methods here are **domain methods, not a generic `read`**, so they may carry their own
fields — but the four anchoring fields **keep their TAPI-23 names and stay flat at the top level**. The sibling
DeFi examples instead nest them under `blockPinned`. **This is a real inconsistency, not a typo**: those
examples read BSC, this repo's home chain, where `blockPinned` is the local convention, whereas this one is a
TAPI-23 cross-chain read whose consumers compare `chainId` / `blockNumber` / `blockHash` field by field per
§3.4 step 4. A generic TAPI-23 client would not find them under another name. **Every `chains[i]` entry of
`portfolio` carries the same four flat fields**, because each chain is pinned independently.

---

## 主戏：TAPI-23 §3.4 的五步法定人数 / The main event: the five-step quorum

**中文**：TAPI-23 §3.4 是一条**客户端规则**。提供者签名只证明「我这么说」，把「这是真的」变成可依赖的结论，
靠的是调用方把两家独立提供者的字节比一比。下面五步逐条对应真实代码。

**EN**: TAPI-23 §3.4 is a **client-side rule**. A provider's signature only proves "I said this"; turning that
into "this is true" is the caller's job, done by comparing the bytes from two independent providers. The five
steps below map to real code.

### 第 1 步：挑 N ≥ 2 家**独立**提供者 / Step 1: select N ≥ 2 independent providers

**中文**：TAPI-23 §3.5 的独立性有两个条件，**必须同时成立**：

1. **持有人不同**：`IERC721(circuits).ownerOf(tokenId)` 不同 → SDK 解析后放在 `svc.verified.holder`。
2. **来源不同**：实际使用的 `endpoints.live` URL 的 scheme/host/port 不同 → `new URL(svc.manifest.endpoints.live[0]).origin`。

```js
import { createTapeAPI, TapeAPIError, rpcUrlsFor } from '@tapeapi/sdk'
const api = createTapeAPI({ rpcUrls: rpcUrlsFor(56), chainId: 56 })

const [a, b] = await Promise.all([api.resolve('<#123>.4.tape'), api.resolve('<#987>.2.tape')])

// TAPI-23 §3.5 的独立性检查——**你自己做，SDK 不做**
function assertIndependent(x, y) {
  const originOf = (s) => new URL(s.manifest.endpoints.live[0]).origin
  if (!x.verified.holder || !y.verified.holder) throw new Error('holder unknown; cannot judge independence')
  if (x.verified.holder.toLowerCase() === y.verified.holder.toLowerCase()) throw new Error('same holder: one operator, not two sources')
  if (originOf(x) === originOf(y)) throw new Error('same origin: one endpoint, not two sources')
}
assertIndependent(a, b)
```

> **SDK 的 `callQuorum` 不替你做这个检查。** 它只做两件事：拒绝重复的 `container`，以及提供者数量少于
> `quorum` 时抛错（见 `sdk/src/index.js` 的 `duplicate provider` 与 `quorum N needs at least N providers`）。
> **持有人相同、origin 相同的两家，它会照样当成两个来源。** 独立性是调用方的责任。
>
> **The SDK's `callQuorum` does NOT do this check for you.** It only rejects duplicate `container` values and
> throws when there are fewer providers than `quorum`. Two services sharing a holder or an origin are counted
> as two sources by `callQuorum`. Independence is the caller's responsibility.

**dev 模式下这个检查是空的**：本地实例的 `delegation` 是 `null`，`svc.verified.holder` 因此是 `null`，
`container` 也是 manifest 里的占位零地址。所以本地演示必须用 `CONTAINER=` 给两份实例不同的地址（否则
`callQuorum` 会以 `duplicate provider` 拒绝），而真正的独立性检查只在主网上才有意义。
**In dev the check is vacuous**: a local instance has `delegation: null`, so `svc.verified.holder` is `null`
and `container` is the manifest's placeholder zero address. The local demo therefore has to give the two
instances distinct `CONTAINER=` values (otherwise `callQuorum` rejects them as `duplicate provider`), and the
real independence check only bites on mainnet.

### 第 2 步：两段式钉块 / Step 2: two-phase block pinning

**中文**：**法定人数轮 MUST 用显式数字块号。** 省略 `block` 或传 `'finalized'` / `'latest'` 这类标签时，
两家提供者在**不同时刻**解析同一个标签，落在不同的块上，答案合法地不同。所以：先向**任意一家**问一次，
取回它的 `blockNumber`，再把**那个数字**发给所有家。

```js
const params = { chainId: 56, address, tokens }

// 2a) 先问一家，拿块号（这一次不是 quorum，只是为了要一个块）
const first = await api.call(a, 'balances', params)
const block = first.result.blockNumber          // 顶层扁平字段，见上一节

// 2b) 把同一个显式数字块号发给每一家
const r = await api.callQuorum([a, b], 'balances', { ...params, block }, { quorum: 2 })
```

> 先问的那一家**不能**借此左右结果：其余每一家都用自己的上游独立核对那个块号的 hash，并**在该 hash 上**
> 求值（§3.2 第 2 条）。一个错的或非规范链上的块只会导致分歧或报错，**永远不会**变成一个错误的一致答案。
>
> The provider asked first cannot bias the result: every other provider independently verifies that block's
> hash against its own upstream and evaluates **at that hash** (§3.2.2). A wrong or non-canonical block yields
> disagreement or an error, never a wrong agreed answer.

### 第 3–5 步：验签 → 逐字节比较 → 有分歧就拒绝 / verify, compare, reject

**中文**：这三步 `callQuorum` 替你做了，但你要知道它做的是什么：

- **第 3 步 验签**：每份信封各自按 TAPI-21 验签。验不过或没收到的，算**传输失败**（进 `failed`），
  **不算分歧**——这个区分很重要，一个连不上的提供者不应该被当成一个说谎的提供者。
- **第 4 步 比较**：两份信封**一致**当且仅当 `chainId`、`blockNumber`、`blockHash`、`result` **逐字节相同**
  （`canonicalJSON` 递归排序后比较）。注意块也在比较范围内——**值一样但块不一样，依然是分歧**。
- **第 5 步 拒绝**：至少两份已验签信封、且**全部**一致才接受。**任意两份已验签结果不同即拒绝，
  不做多数表决、不按声誉、不只重试少数派。** 三家里两家一致也一样拒绝。

```js
try {
  const r = await api.callQuorum([a, b], 'balances', { ...params, block }, { quorum: 2 })
  console.log('agreed:', r.result.tokens[0].formatted, 'by', r.agreed)
} catch (e) {
  if (e.code === 'QUORUM_FAILED') {
    // 细节在 e.data 里（1.0 起；顶层的 e.groups 等只是弃用别名）/ the details are in e.data (1.0; e.groups etc. are deprecated aliases)
    console.error(e.message, e.data.groups, e.data.disagreed, e.data.failed)
  } else throw e
}
```

成功时 `callQuorum` 返回 `{ result, agreed, disagreed, failed, verified, quorum, responses, groups }`。

**EN**: `callQuorum` performs steps 3–5, but know what it is doing. **Step 3 verify**: each envelope is
TAPI-21-verified on its own; envelopes that fail verification or never arrive are **transport failures**
(reported in `failed`), **not disagreement** — an unreachable provider must not be treated as a lying one.
**Step 4 compare**: two envelopes agree iff `chainId`, `blockNumber`, `blockHash` and `result` are
byte-identical. The block is part of the comparison, so **the same value at a different block is still a
disagreement**. **Step 5 reject**: accept only when at least two verified envelopes arrived and **all** of them
agree. **Any two differing verified envelopes reject — no majority vote, no reputation, no retrying just the
minority.** Two-out-of-three agreeing is still a rejection. On failure the details are in `e.data`:
`e.data.groups` / `e.data.disagreed` / `e.data.failed` (the top-level names are deprecated aliases until 2.0).

> `onDissent: 'quorum'` 是一个**明确的降级**，默认关闭：它让唯一达到法定人数的那一组获胜，把失败模式从
> 「拒绝」换成「可被 `quorum` 家合谋伪造」。只有当你自己挑选并信任这批提供者时才用它。
> `onDissent: 'quorum'` is an explicit, off-by-default weakening: it lets the single bucket reaching quorum
> win, trading "deny" for "forgeable by `quorum` colluding providers". Only defensible when you picked the set.

---

## 本地双提供者演示 / Local two-provider demo

**中文**：第二份实例一律用**主端口 + 10**（8795 → 8805），与 `consumer-snippets.md` 现有的 8789 → 8799 约定一致。

```sh
# 两份实例，container 必须不同，否则 callQuorum 以 duplicate provider 拒绝
PORT=8795 FREE_ALL=1 CONTAINER=0x1111111111111111111111111111111111111111 \
  node examples/defi-portfolio-read/index.mjs &
PORT=8805 FREE_ALL=1 CONTAINER=0x2222222222222222222222222222222222222222 \
  node examples/defi-portfolio-read/index.mjs &
```

```js
// demo.mjs —— 在 tapeapi/ 工作区内跑
import { createTapeAPI } from '@tapeapi/sdk'
const api = createTapeAPI({ dev: true, allowHttp: true })
const [a, b] = await Promise.all([
  api.resolve({ dev: 'http://127.0.0.1:8795' }),
  api.resolve({ dev: 'http://127.0.0.1:8805' }),
])
const params = { chainId: 56, address: '0xF977814e90dA44bFA03b6295A0616a897441aceC',
                 tokens: ['0x55d398326f99059fF775485246999027B3197955'] }
const first = await api.call(a, 'balances', params)        // 第 2 步：先要一个块
const block = first.result.blockNumber
const r = await api.callQuorum([a, b], 'balances', { ...params, block }, { quorum: 2 })
console.log('AGREED', r.result.tokens[0].formatted, r.agreed)
```

实测输出（2026-09-20，BNB Chain 主网）/ measured output:

```
AGREED 400000044.550414142971145809 [
  '0x1111111111111111111111111111111111111111',
  '0x2222222222222222222222222222222222222222'
]
```

### 制造一次 `QUORUM_FAILED` / Forcing a `QUORUM_FAILED`

**中文**：让第二份实例落在**不同的块**上就行。`BLOCK_LAG` 覆盖 `chains.json` 的 `lag`，配合 `block: 'latest'`
即可（`'latest'` 解析成 `min(head) − lag`）：

```sh
PORT=8805 FREE_ALL=1 CONTAINER=0x2222…2222 BLOCK_LAG=50 \
  node examples/defi-portfolio-read/index.mjs &
```

然后把上面 demo 的参数换成 `{ ...params, block: 'latest' }`（**故意违反第 2 步**，用标签而不是显式块号）。
实测输出：

```
code   : QUORUM_FAILED
message: balances: 2 distinct verified answers; TAPI-23 rejects on any disagreement
         (pass onDissent:'quorum' to accept a dominant group instead)
groups : [
  { "blockNumber": 123020121, "blockHash": "0xfde02fc3fa25c82bf5…",
    "usdt": "400000044.550414142971145809", "containers": ["0x1111…1111"] },
  { "blockNumber": 123020074, "blockHash": "0xfd42a239ba0f98f29b…",
    "usdt": "400000044.550414142971145809", "containers": ["0x2222…2222"] }
]
disagreed: [ '0x1111…1111', '0x2222…2222' ]
failed   : []
```

**请看清楚这一点**：两家的 USDT 余额**一模一样**，依然 `QUORUM_FAILED`。因为第 4 步比较的是
`{chainId, blockNumber, blockHash, result}` 的**整体**，不是你关心的那个数。两个块不同 → 两份关于**不同
状态**的陈述 → 不可比。`disagreed` 里两家都在（没有"赢家"组），`failed` 为空（两家都给了可验签的答案，
只是彼此不一致——这不是传输失败）。这也正是第 2 步存在的理由。

**EN**: Point the second instance at a different block. `BLOCK_LAG` overrides `chains.json`'s `lag`, and
`'latest'` resolves to `min(head) − lag`, so a different lag lands on a different block. Then call with
`block: 'latest'` — **deliberately violating step 2** by using a tag instead of an explicit number.
**Note carefully**: both providers report the *identical* USDT balance and it still fails, because step 4
compares the whole `{chainId, blockNumber, blockHash, result}` tuple, not the number you care about. Different
blocks are statements about *different states* and are not comparable. Both containers appear in `disagreed`
(there is no winning group) and `failed` is empty — both gave verifiable answers that simply disagree, which
is not a transport failure. This is precisely why step 2 exists.

---

## 数值与确定性 / Numbers and determinism

**中文**：跨提供者逐字节比较（第 4 步）对数值格式的要求很硬，所以：

- **全程 BigInt，向零截断**（BigInt 整除）。`Number` 只出现在 `blockNumber`、数组下标、`decimals` 这类小整数上，
  **绝不参与任何金额运算**，也没有任何浮点。
- **定宽小数用 `_lib/codec.mjs` 的 `fixed` / `fixedDiv`**，不用 SDK 的 `formatUnits`。
  `formatUnits` 会剥掉末尾的零（`formatUnits(2e18, 18) === "2"`），位数就不固定了，与 manifest `returns` 里
  写死的位数对不上。`share` 因此是 `fixedDiv(lpBalance, totalSupply, 18)`，永远 18 位小数。
  > 澄清一句：`formatUnits` 本身**不破坏确定性**——两家跑同样的代码会同样地剥零，字节仍然一致。
  > 它破坏的是**位宽契约**（SPEC §0.3.2「位数固定」），这是两回事。
- **唯一的例外是 `tokens[i].formatted`**：SPEC §4.3 明文指定它用 `formatUnits(balance, decimals)`，
  为与既有示例保持连续性而保留。所以 `formatted` **不是**定宽的（`"0"`、`"142.2445"`），而 `share` 是
  （`"0.000000000661605533"`）。同一个 result 里两种风格并存，是规范要求的，不是疏忽。
- **数组顺序 == 入参顺序**，重复入参照样重复，**不去重、不重排**，也绝不依赖 `Promise.all` 的完成顺序。
- **签名 `result` 里没有**本地时钟、耗时、provider 名字/URL/版本、RPC 主机名、随机数。信封的 `ts` 是
  TAPI-21 的信封字段，不是 result 字段。

**EN**: Byte-for-byte comparison makes number formatting load-bearing. All arithmetic is BigInt truncated
toward zero; `Number` appears only for small integers like `blockNumber`, array indices and `decimals`, never
in an amount, and there is no floating point anywhere. Fixed-width decimals use `fixed` / `fixedDiv` from
`_lib/codec.mjs` rather than the SDK's `formatUnits`, which strips trailing zeros and so cannot honour the
fixed width the manifest's `returns` declares — `share` is therefore always 18 places.
*To be precise: `formatUnits` does not break determinism* — two providers running the same code strip the same
zeros and the bytes still match. What it breaks is the **width contract** (SPEC §0.3.2), which is a different
defect. **The one exception is `tokens[i].formatted`**, which SPEC §4.3 specifies as `formatUnits(balance,
decimals)` for continuity with the existing examples: so `formatted` is *not* fixed-width (`"0"`,
`"142.2445"`) while `share` is (`"0.000000000661605533"`). Both styles coexist in one result by specification,
not by oversight. Arrays come back in caller order with duplicates preserved, never deduped, reordered, or
ordered by `Promise.all` completion. The signed `result` contains no local clock, elapsed time, provider
name/URL/version, RPC hostname or randomness; the envelope's `ts` is a TAPI-21 envelope field, not a result field.

### `TOKEN_READ_FAILED`：只标记数据本身的问题 / only a fault in the data

**中文**：某个 token 的 `symbol`/`decimals`/`balanceOf` 读不出来时，该项返回
`{ token, symbol: null, decimals: null, balance: null, formatted: null, error: "TOKEN_READ_FAILED" }`，
**保留在原位**（丢掉就破坏了顺序保证），**整个请求不失败**。`error` 是**固定字符串**——上游的错误消息可能
带 RPC 主机名，放进签名 result 会违反确定性。

但有一条**关键的区分**：只有**合约本身**读不出来（revert、返回的不是 ABI 说的东西、非标准 ERC-20）才降级。
这在锚定块上是一个确定事实，每家提供者都会同样失败，不影响逐字节一致。
**传输故障不降级，向上抛**，整个请求以 `INTERNAL` 失败，由调用方重试。理由：我这边网络抖一下就标
`TOKEN_READ_FAILED`，另一家返回真实余额，两份已验签结果逐字节不同 → `QUORUM_FAILED`，**而谁都没说谎**。
（这不是假想：本示例第一版就因为一次上游超时，把完全标准的以太坊 USDT 标成了非标准代币。）

**EN**: A token that cannot be read keeps its slot with a fixed `error: "TOKEN_READ_FAILED"` string and never
fails the whole request; the string is fixed because an upstream message can carry an RPC hostname. **But only
a fault in the contract's own data degrades this way** — a revert, malformed return data, a non-standard
ERC-20. That is a fact about the pinned block, identical for every provider. **A transport failure is rethrown**
and fails the request as `INTERNAL` for the caller to retry, because otherwise one network blip here plus
another provider's honest balance become two byte-different verified envelopes and `QUORUM_FAILED` although
nobody lied. Not hypothetical: the first cut of this example labelled the perfectly standard Ethereum USDT a
non-standard token after a single upstream timeout.

### `lpV3` 为什么不换算成 token 数量 / why `lpV3` returns raw parameters

**中文**：`lpV3` 只返回 NFT 仓位的**原始参数**（`liquidity`、`tickLower`、`tickUpper`、`feeGrowthInside*`、
`tokensOwed*`），**不**换算成 token0/token1 的数量。换算需要 `slot0()` 的现价和 TickMath 的定点实现，那是
`examples/defi-twap-oracle/` 的职责；在这里再写一遍会让两个示例的定点实现**分叉**，而定点实现一分叉，
两家提供者就可能在边界上给出不同的字节。要数量，请把这里的 tick 区间喂给那个示例。

`tickLower` / `tickUpper` 是 `int24`。ABI 把它**符号扩展到整个 32 字节字**，所以二补码转换按 **256 位** 做
（`_lib/codec.mjs` 的 `intWordAt`），**不是按 24 位**——按 24 位会把 `-887220` 解成
`115792089237316195423570985008687907853269984665640564039457584007913128752716`。
主网实测确认：本示例在 PancakeSwap V3 上读到过 `tickLower: "-35"`、`"-117"` 这样的真实负 tick。
（另注：`feeGrowthInside*LastX128` 是 `uint256`，Uniswap V3 的数学**有意让它回绕**，所以它经常是一个接近
`2^256` 的巨大数字。那是正确的无符号值，**不要**把它当成负数去解。）

**EN**: `lpV3` returns the raw position parameters only and never converts a tick range into token amounts.
That conversion needs `slot0()` and a TickMath fixed-point implementation, which belongs to
`examples/defi-twap-oracle/`; duplicating it here would fork the fixed-point implementation, and a forked
implementation is exactly how two providers end up with different bytes at a boundary. Feed these tick ranges
to that example if you need amounts. `tickLower` / `tickUpper` are `int24`, sign-extended by the ABI across the
whole 32-byte word, so the two's-complement conversion is done at **256 bits**, never at 24 — at 24 bits
`-887220` decodes as an astronomical number. Verified against mainnet: real negative ticks such as `-35` and
`-117` come back correctly. Note also that `feeGrowthInside*LastX128` is a `uint256` that Uniswap V3's maths
**intentionally wraps**, so it is often a huge number near `2^256`; that is the correct unsigned value and must
not be read as a negative.

---

## 重组 / Reorgs

**中文**：默认钉 `finalized`，并一律用 EIP-1898 的 `{ blockHash, requireCanonical: true }` 求值——所以结果
**永远不会**悄悄来自另一条分叉：最坏情况是报错。

只有当上游节点**拒绝块对象本身**（不是调用 revert）时，才退回按块号求值，并在结果里把 `blockRef` 置为
`"number"`。按 TAPI-23 §3.2 第 3 条，**`blockRef === "number"` 是更弱的证据**：块号与 hash 之间存在重组窗口，
签名的 `result` 不一定属于它所声明的 `blockHash`。**消费者可以直接拒绝这种结果**，这是规范明确允许的：

```js
if (r.result.blockRef === 'number') throw new Error('weaker evidence than blockHash; rejecting')
```

非最终块的 `blockHash` 仍可能被孤立。请在目标链的最终性窗口内取块，必要时稍后重读。

**EN**: The default is `finalized`, and every read is evaluated at `{ blockHash, requireCanonical: true }`, so a
result can never be silently taken from a different fork — the worst case is an error. Only when an upstream
node **rejects the block object itself** (not when the call reverts) does the provider fall back to evaluating
by number and set `blockRef: "number"`. Per TAPI-23 §3.2.3 that is **weaker evidence** — a reorg can occur
between the number and the hash, so the signed `result` may not belong to the `blockHash` it names — and a
**consumer may simply reject it**. A `blockHash` on a non-final block can still be orphaned; request blocks
inside the target chain's finality window and re-read later if it matters.

---

## dev → 主网 / dev to mainnet

**中文**：现在 `manifest.json` 是 `dev: true`、`delegation: null`、`circuits`/`container`/`escrow` 全是占位零地址、
`tokenId: "0"`。上主网要改：

| 改什么 | 怎么改 |
|---|---|
| `SIGNER_KEY` | 固定的签名私钥。不设会用临时 signer（**私钥不打印**）；设了 `DELEGATION_SIG` 却不设它会**直接退出**，因为委托指名了一个固定 signer。 |
| `DELEGATION_SIG` + `DELEGATION_EXPIRES` | 由电路持有人签发的委托。**两个都设上 `dev` 自动变 `false`**，`delegation` 随之填好。 |
| `CIRCUITS` + `TOKEN_ID` | 你的电路合约与 token id，决定 `ownerOf` 查出来的持有人——TAPI-23 §3.5 独立性的第一个条件。 |
| `CONTAINER` | 链上容器地址，必须与 manifest 对得上。 |
| `ESCROW` | TAPI-22 托管合约地址（收费才需要）。 |
| `PUBLIC_URL` | 对外的 `https://` 地址，写进 `endpoints.live`——TAPI-23 §3.5 独立性的第二个条件。**两家提供者的 origin 必须不同。** |
| RPC 组 | 换成你自己的付费/自建节点。公共 RPC 会限流也会掉线（见下）。`RPC_56` / `RPC_1` / `RPC_8453` 覆盖 `chains.json`。 |
| `FREE_ALL` | **主网不要设**。它只在 `dev` 下把所有 `priceBEM` 清零。 |

> **公共 RPC 的实测情况（2026-09-20）**：`chains.json` 里 `eth.llamarpc.com` 返回 HTTP 525（**已挂**），
> `ethereum-rpc.publicnode.com` 间歇超时；Base 只配了 **2 个** URL 而 `quorum` 是 **2**，意味着**零冗余**——
> 任何一个节点抖动，整条链的请求就失败。这不是代码问题，是默认配置的脆弱性。
> 生产环境请把每条链配到 **至少 `quorum + 1`** 个健康节点。
>
> **Measured on public RPCs (2026-09-20)**: `eth.llamarpc.com` returns HTTP 525 (dead) and
> `ethereum-rpc.publicnode.com` times out intermittently; Base is configured with **2** URLs at `quorum` **2**,
> i.e. **zero redundancy** — one flaky node fails every request for that chain. Configure **at least
> `quorum + 1`** healthy nodes per chain in production.

---

## 什么时候不要用这个 / When not to use this

> 本节来自我们对 DeFi 需求的研究。说得直白一点比事后被人指出来好。

**中文**

1. **单提供者的签名响应，不能当借贷协议的主价格喂价。不是"调一调就行"，是结构上不行。**
   一个 TapeAPI 提供者就是一个 **single-source feed**，你拿到的全部保证就是那一把私钥。

2. **TAPI-23 的法定人数规则是一条 *客户端* 规则，没有任何链上合约会执行它。**
   §3.4 那五步写给的是 JS/后端调用方。`Comptroller.liquidateBorrowAllowed` 里没有 `callQuorum`，
   合约能验证的只有它自己能算的东西。所以真正的问题从来不是"要几个签名"，而是**链上消费者到底验证了什么**。
   在出现"链上多见证验证"合约（≥threshold 份逐字节一致、有分歧就 revert、**绝不取多数**）之前，
   这条规则保护的只是你的后端进程。

3. **没有质押，没有罚没。** TAPI-23 §3.6 明文把 stake/slash 留给未来的 TAP，并且要求
   *"clients MUST NOT assume any provider is staked"*。一个签了错数据的提供者，今天损失的上限是**声誉**。
   对面站着的可能是一次几百万美元的清算。

4. **连 Chainlink 都不承担这个责任。** docs.chain.link/data-feeds/selecting-data-feeds 原话：
   > "Ultimately you are responsible for identifying and assessing the accuracy, availability, and quality of
   > data that you choose to consume via the Chainlink Network."
   >
   > "Users of single-source feeds MUST implement additional safeguards such as value bounds, caps, circuit
   > breakers, freshness checks, fallback behavior, monitoring against independent references where available,
   > and manual pause or kill-switch controls."

   按 Chainlink 自己的标准，用单源喂价的协议**必须**外加**界限、上限、熔断、新鲜度检查、回退行为、
   对独立参照的监控、以及人工暂停/kill switch**。这不是贬低 TapeAPI，这是它能被正当使用的**前提条件**。

5. **延迟天花板。** HTTPS + 签名信封 + 默认钉 `finalized`，落在"风控/监控/前端（秒到分钟）"这一档。
   竞速清算（区块内、毫秒级）、借贷主喂价（≤ 27 s heartbeat）、永续/高频（亚秒）、RFQ（750 ms）
   **不是优化一下就能进，是结构上进不去**。

**今天可以放心做的**：清算/风控机器人的**监控**通道（不是竞速通道）；借贷/DEX 前端的**可归属**数据源
（用户能看到这个数字属于哪个区块、由哪两家独立提供者签过名）；**二级源 / 熔断锚**——正是 Chainlink 要求
单源使用者做的那条 *"monitoring against independent references"*；以及 OEV/清算的**事后审计材料**。

**EN**

1. **A single-provider signed response is not a lending protocol's primary price feed** — not "after some
   tuning", but structurally. One TapeAPI provider is a **single-source feed**; your entire assurance is that
   one key.
2. **TAPI-23's quorum rule is a *client-side* rule that no on-chain contract enforces.** The five steps address
   a JS/backend caller. There is no `callQuorum` inside `Comptroller.liquidateBorrowAllowed`. Until an on-chain
   multi-witness verifier exists (≥threshold byte-identical envelopes, revert on any disagreement, **never a
   majority**), this rule protects your backend process and nothing else.
3. **There is no stake and no slashing.** TAPI-23 §3.6 defers both to a future TAP and states that *clients MUST
   NOT assume any provider is staked*. A provider that signs bad data risks its reputation, against an
   incentive that can be millions of dollars in one liquidation.
4. **Chainlink does not accept this responsibility either** — see the two quoted lines above. By Chainlink's
   own standard, protocols consuming a single-source feed **MUST** add bounds, caps, circuit breakers,
   freshness checks, fallback behaviour, monitoring against independent references, and manual pause or
   kill-switch controls. That is the precondition for using this legitimately, not a criticism of it.
5. **Latency ceiling.** HTTPS plus a signed envelope plus a `finalized` default lands in the
   "risk/monitoring/frontend, seconds to minutes" tier. Race liquidations (intra-block, milliseconds), a
   lending primary feed (≤ 27 s heartbeat), perps (sub-second) and RFQ (750 ms) are structurally out of reach.

**What this is genuinely good for today**: the *monitoring* channel for liquidation and risk bots (not the
racing channel); an *attributable* data source for a lending or DEX frontend, where a user can see which block
a number came from and which two independent providers signed it; a *secondary source / circuit-breaker
anchor*, which is exactly the "monitoring against independent references" Chainlink asks single-source
consumers to implement; and after-the-fact audit material for OEV and liquidations.

---

## curl

所有数值随区块变化，形状固定。以下输出为 2026-09-20 在 BNB Chain / Ethereum / Base 主网实测。
Values move with the block; the shape does not. The outputs below were measured on mainnet on 2026-09-20.

### `balances`（BSC）

```sh
curl -s -X POST http://127.0.0.1:8795/tapeapi/v1/balances -H 'content-type: application/json' -d '{
  "id":"b-1",
  "params":{"chainId":56,
            "address":"0xF977814e90dA44bFA03b6295A0616a897441aceC",
            "tokens":["0x55d398326f99059fF775485246999027B3197955",
                      "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
                      "0x5ce033b2bfca3af30b3e8c8457deaf776a8b695a"]}}' | jq .
```

```jsonc
{"id":"b-1","ok":true,"result":{
  "chainId":56,"blockNumber":123018562,
  "blockHash":"0xa0a2eb8ea15e7182f7db60049f2fff0fd497bb46c0bebcc034d48407490d7ae2",
  "blockRef":"hash","address":"0xF977814e90dA44bFA03b6295A0616a897441aceC",
  "native":{"symbol":"BNB","decimals":18,"balance":"6735702781891636147997615",
            "formatted":"6735702.781891636147997615"},
  "tokens":[
    {"token":"0x55d398326f99059fF775485246999027B3197955","symbol":"USDT","decimals":18,
     "balance":"400000044550414142971145809","formatted":"400000044.550414142971145809"},
    {"token":"0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c","symbol":"WBNB","decimals":18,
     "balance":"116109694839977807594","formatted":"116.109694839977807594"},
    {"token":"0x5ce033B2bFCa3Af30b3e8C8457DeaF776A8b695a","symbol":"BEM","decimals":8,
     "balance":"0","formatted":"0"}]},
 "container":"0x…","ts":1789920495,"block":123018564,"sig":"0x…"}
```

传显式 `"block":123207091` 就能复现同一个块——这正是第 2 步要做的事。
Pass an explicit `"block"` to reproduce the same block; that is exactly what step 2 does.

### `lpV2`（PancakeSwap V2 WBNB/USDT）

```sh
curl -s -X POST http://127.0.0.1:8795/tapeapi/v1/lpV2 -H 'content-type: application/json' \
  -d '{"id":"lp-1","params":{"chainId":56,"address":"0x0000000000000000000000000000000000000000",
       "pair":"0x16b9a82891338f9bA80E2D6970FddA79D1eb0daE"}}' \
  | jq '.result | {share,amount0,amount1,blockNumber}'
```

```jsonc
{ "share": "0.000000000661605533",   // 18 位定宽 / fixed 18 places
  "amount0": "26004057759942909",    // USDT wei
  "amount1": "34366684627173",       // WBNB wei
  "blockNumber": 123018587 }
```

> 零地址在这里**确实是一个真实持有人**：UniswapV2/PancakeV2 在第一次铸造时会把
> `MINIMUM_LIQUIDITY` 永久锁死给 `address(0)`（实测 LP 余额 `348500000001000`）。
> 两边的价值都约合 $0.026，与当时 ~757 USDT/BNB 的储备比一致。
> The zero address really is a holder here: V2 permanently locks `MINIMUM_LIQUIDITY` to `address(0)` at first
> mint. Both sides value to about $0.026, consistent with the ~757 USDT/BNB reserve ratio at that block.

### `lpV3`（PancakeSwap V3 NFT 仓位，仅 chainId 56）

```sh
curl -s -X POST http://127.0.0.1:8795/tapeapi/v1/lpV3 -H 'content-type: application/json' \
  -d '{"id":"v3-1","params":{"chainId":56,"address":"0x556B9306565093C855AEA9AE92A594704c2Cd59e","limit":3}}' | jq .
```

```jsonc
{"chainId":56,"blockNumber":123019470,"blockHash":"0x62dc11…4e31","blockRef":"hash",
 "address":"0x556B9306565093C855AEA9AE92A594704c2Cd59e",
 "manager":"0x46A15B0b27311cedF172AB29E4f4766fbE7F4364",
 "count":"83173",                       // 字符串，与其它数量字段一致 / a string, like every other count
 "positions":[
   {"tokenId":"402354","token0":"0x55d398326f99059fF775485246999027B3197955",
    "token1":"0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56","fee":"100",
    "tickLower":"-35","tickUpper":"-27",     // 真实的负 int24 / real negative int24 values
    "liquidity":"0",
    "feeGrowthInside0LastX128":"115792089237316195423570985008687907853269982095249642686881665317367220752089",
    "feeGrowthInside1LastX128":"115792089237316195423570985008687907853269982135806143900260097375840772156328",
    "tokensOwed0":"0","tokensOwed1":"0"}]}
```

`count` 是该地址持有的**全部**仓位数，`positions` 只返回 `min(count, limit)` 条（`limit` 省略为 20，上限 20）。
`count` is the address's total position count; `positions` returns only `min(count, limit)` entries.

### `portfolio`（三条链，各自锚定）

```sh
curl -s -X POST http://127.0.0.1:8795/tapeapi/v1/portfolio -H 'content-type: application/json' -d '{
  "id":"p-1","params":{"address":"0xF977814e90dA44bFA03b6295A0616a897441aceC",
    "chains":[{"chainId":56,  "tokens":["0x55d398326f99059fF775485246999027B3197955"]},
              {"chainId":1,   "tokens":["0xdAC17F958D2ee523a2206206994597C13D831ec7"]},
              {"chainId":8453,"tokens":["0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"]}]}}' | jq .
```

```jsonc
{"address":"0xF977814e90dA44bFA03b6295A0616a897441aceC","chains":[
  {"chainId":56,  "blockNumber":123018923,"blockHash":"0x5f50b7…2a85","blockRef":"hash", …,
   "native":{"symbol":"BNB","decimals":18,"formatted":"6735702.781891636147997615"}, …},
  {"chainId":1,   "blockNumber":26019767, "blockHash":"0x57ad40…d7b8","blockRef":"hash", …,
   "native":{"symbol":"ETH","decimals":18,"formatted":"539595.915382569565294208"}, …},
  {"chainId":8453,"blockNumber":51565031, "blockHash":"0x699abe…0cb8","blockRef":"hash", …,
   "native":{"symbol":"ETH","decimals":18,"formatted":"30002.600051521416253385"},
   "tokens":[{"token":"0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913","symbol":"USDC","decimals":6,
              "balance":"15115045208","formatted":"15115.045208"}]}]}
```

三个块号互不相同，**这正是 `portfolio` 是 `[no-quorum]` 的原因**。`native.symbol` 来自 `chains.json` 的静态
配置（`bsc`→`BNB`、`ethereum`/`base`→`ETH`），**从不联网推断**。
The three block numbers differ, which is **exactly why `portfolio` is `[no-quorum]`**. `native.symbol` comes
from the static `chains.json` config and is never inferred over the network.

---

## 文件 / Files

| 文件 | 作用 |
|---|---|
| `index.mjs` | 服务进程。`chains` Map / `pinBlock` / `readAt` / `attestedCall` 原样照抄 `examples/chain-attested-read/index.mjs`，env 前言照抄 `examples/defi-price-oracle/index.mjs`。 |
| `portfolio.mjs` | **纯函数**：校验、解码、金额换算、结果组装。不碰网络。 |
| `portfolio.test.mjs` | `node:test`，**不联网**（纯函数全在 `portfolio.mjs`，所以一个 socket 都不开）。 |
| `chains.json` | 每条链的 `name` / `symbol` / `lag` / `quorum` / `rpcUrls`。`RPC_<chainId>` 与 `BLOCK_LAG` 可覆盖。 |
| `manifest.json` | TAPI-20 清单。`balances` / `lpV2` / `lpV3` 三个方法带 TAPI-23 §3.1 的 `attestedRead` 档案字段。 |

**为什么 `portfolio` 没有 `attestedRead`**：TAPI-23 §3.1 规定客户端*「以 `attestedRead` 的存在而非名称来发现
见证读取服务」*。给一个 `[no-quorum]` 方法挂上这个字段，等于邀请通用客户端把它选进法定人数轮，而那必然
`QUORUM_FAILED`。所以只有三个真正可 quorum 的方法带它；`lpV3` 的 `chains` 只有 `[56]`，与它实际服务的链一致。
**Why `portfolio` has no `attestedRead`**: TAPI-23 §3.1 has clients *discover Attested Read services by the
presence of `attestedRead`, not by name*. Advertising it on a `[no-quorum]` method would invite a generic
client to select it for a quorum round, which is guaranteed to `QUORUM_FAILED`. Only the three genuinely
quorumable methods carry it, and `lpV3`'s `chains` is `[56]` to match the chain it actually serves.

ABI 编解码来自共享库 `examples/_lib/codec.mjs`（`W` / `padAddr` / `wordAt` / `intWordAt` / `fixed` / `fixedDiv`）。
不新增任何 npm 依赖：只用 `@tapeapi/server`、`@tapeapi/sdk` 和 `node:` 内置模块。
ABI codecs come from the shared `examples/_lib/codec.mjs`. No new npm dependencies: only `@tapeapi/server`,
`@tapeapi/sdk` and `node:` builtins.
