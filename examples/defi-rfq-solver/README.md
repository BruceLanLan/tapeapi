# defi-rfq-solver — TAPI-24 Solver 参考骨架

> 本示例**没有真实库存、没有做市能力、没有风控**。它用一个可配置的固定价格表 + 固定价差生成**格式合法**的 EIP-712 签名报价，用来验证 TAPI-24 §3.3 的 typehash、digest、签名恢复和过期语义，以及 `IntentEscrow` 尚未部署时客户端侧的完整链路。
> **任何人按这个报价打款都会亏钱。** `IntentEscrow` 在 TAPI-24 §7 里被明确标注为 v0.4 交付物、当前不存在（`spec/TAPI-24.md` §6 的 "IntentEscrow address (CREATE2) | TODO (not deployed)"），因此 `escrow` 字段默认返回配置里的占位地址，且 `status()` 的填充状态来自**本地内存**，不是链上事实。

## 它是什么

一个跑在 `:8794` 的 TapeAPI 服务，实现 TAPI-24 §3.2 的 `quote` 方法，外加三个辅助方法。它的用途是**给 TAPI-24 的实现者一个可以跑起来、可以逐字节核对的参照**：

- 报价的 EIP-712 域、主类型、`structHash`、`digest` 与 65 字节签名，全部按 TAPI-24 §3.3 构造，启动时用 `spec/TAPI-24.md` §6 的测试向量自检（`keccak256(主类型串)` 必须等于 `QUOTE_TYPEHASH`，`keccak256("IntentEscrow")` 必须等于域名哈希），**对不上就拒绝启动**。
- 两层签名都能验：报价本身由 `solver` 私钥按 EIP-712 签（链上 `ecrecover` 可验），整个 `result` 再由 TAPI-21 信封签名覆盖（绑到服务身份）。
- 定价全程 BigInt、向零截断，公式与参数都在 `quote.config.json` 里。

所有纯逻辑在 `quote.mjs`（定价、EIP-712、参数校验、报价簿），`index.mjs` 只负责 env、链读与 HTTP，`quote.test.mjs` 直接测 `quote.mjs`——单测**不开套接字、不联网**。这与 `examples/web2-adapter/adapter.mjs` 是同一个分层方式。

## 三步运行

```sh
npm install --no-audit --no-fund                        # 在 tapeapi/ 根目录，一次
node examples/defi-rfq-solver/index.mjs                 # :8794；SOLVER_KEY=0x.. 可固定 solver 地址
curl -s -X POST http://127.0.0.1:8794/tapeapi/v1/routes -H 'content-type: application/json' -d '{"id":"1","params":{}}'
```

启动日志会打印 `solver` 地址、`signer` 地址和自检过的 typehash。两把私钥都**不打印**。

## 方法表：哪些能进 quorum，哪些不能

| 方法 | 价格 | quorum | 说明 |
|---|---|---|---|
| `quote({fromChain,fromToken,amountIn,toChain,toToken,recipient,ttl?})` | 免费 | **`[no-quorum]`** | EIP-712 签名报价。**不要把它放进 `callQuorum`，会必然 `QUORUM_FAILED`。** |
| `routes({})` | 免费 | **`[no-quorum]`** | 本 Solver 服务的路线与报价参数。**不要把它放进 `callQuorum`，会必然 `QUORUM_FAILED`。** |
| `status({quoteId})` | 免费 | **`[no-quorum]`** | 某个 `quoteId` 的**本地内存**状态。**不要把它放进 `callQuorum`，会必然 `QUORUM_FAILED`。** |
| `inventory({chainId,tokens,block?})` | 免费 | `[quorum]`（有条件） | `solver` 地址在锚定块上的余额，带 `blockPinned`。 |

**为什么 `quote` 不能进 quorum。** TAPI-24 §3.3 要求 `quoteId` 每次唯一（推荐 `keccak256(solver ‖ random32)`），`expires` 是 30–120 秒的绝对时间。两次调用、两家 Solver 的 `result` **必然**不同字节，而 `callQuorum` 的规则是 `canonicalJSON(result)` 逐字节相同。这不是缺陷：**RFQ 的语义是用户在多个报价里挑一个，不是要求多家给出同一个答案。**

**`routes` 的标签：最初的示例规格写错了。** 它把 `routes` 标成 `[quorum]`，这是错的，本示例标 `[no-quorum]`。理由有两条，任一条都足够：按 TAPI-23 §3.4，能进 quorum 的方法必须接受一个显式 `block` 并在结果里回带钉住的块——`routes` 不收参数、不钉任何块；而且它返回 `solver`，这是每个实例自己的地址，两家独立 Solver 永远不可能相同。

**`inventory` 是 `[quorum]`，但只在一种情况下成立。** 它确实钉块（省略 `block` 时钉 `finalized`，按 EIP-1898 `{blockHash, requireCanonical:true}` 求值），所以块锚定这一半是满足的。但它也返回 `solver`：**两家互相独立的 Solver 永远不可能逐字节一致**，因为它们的 `solver` 地址不同。它只在**同一个 Solver 的多个镜像共用同一把 `SOLVER_KEY`** 时可以 quorum——那时几个副本是同一个身份的多个端点，`solver`、`balances`、`blockPinned` 才可能完全相同。做 quorum 轮时按 TAPI-23 §3.4 把**显式数字 `block`** 发给每一个镜像，而且要**尽快**：BSC 公共 dataseed 节点的状态保留窗口很短，实测一个 `finalized` 块在约 1 分钟时还能读，约 3 分钟后同一个 blockHash 就返回 `missing trie node`（`RPC_ERROR`）。晚到的镜像给你的不是「不一致」，而是直接失败。

## curl

```sh
curl -s -X POST http://127.0.0.1:8794/tapeapi/v1/quote -H 'content-type: application/json' -d '{
  "id":"q-1",
  "params":{"fromChain":56,
            "fromToken":"0x55d398326f99059fF775485246999027B3197955",
            "amountIn":"1000000000000000000000",
            "toChain":8453,
            "toToken":"0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
            "recipient":"0x000000000000000000000000000000000000dEaD",
            "ttl":60}}' | jq .
# 实际返回（1000 USDT → 997 USDC，30 bps 价差，18 位 → 6 位）：
# {"id":"q-1","ok":true,"result":{
#   "quote":{"quoteId":"0x72b6…363b","fromChain":56,"fromToken":"0x55d398326f99059fF775485246999027B3197955",
#            "amountIn":"1000000000000000000000","toChain":8453,"toToken":"0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
#            "amountOut":"997000000","recipient":"0x000000000000000000000000000000000000dEaD",
#            "expires":1789920439,"solver":"0x4BbD…9989"},
#   "sig":"0x8efe…1c","escrow":"0x0000000000000000000000000000000000000000",
#   "typehash":"0xe7c18a58c429974068166f7c27b8ba2a9a13177c83aeb69cdcac7a4bc7592d59",
#   "digest":"0xef05…97bd","domain":{"name":"IntentEscrow","version":"1","chainId":56,"verifyingContract":"0x00…00"}},
#  "container":"0x…","ts":…,"block":…,"sig":"0x…"}

curl -s -X POST http://127.0.0.1:8794/tapeapi/v1/status -H 'content-type: application/json' \
  -d '{"id":"s-1","params":{"quoteId":"0x72b6…363b"}}' | jq '.result | {state,expires,onChain,note}'
# { "state": "quoted", "expires": 1789920439, "onChain": null,
#   "note": "IntentEscrow is not deployed; this is local bookkeeping only" }
```

`quote.result.quote` 的字段名与顺序与 TAPI-24 §3.3 的主类型**一字不差**：`{quoteId, fromChain, fromToken, amountIn, toChain, toToken, amountOut, recipient, expires, solver}`——`abi.encode` 就是按这个顺序编的，顺序一变 `digest` 就变。`amountIn`/`amountOut` 一律是**最小单位的十进制字符串**，不做定点渲染（定点串只出现在 `inventory.balances[].formatted` 与 `routes` 的 `maxAmountInFormatted`，用 `examples/_lib/codec.mjs` 的 `fixed()`，因为 SDK 的 `formatUnits` 会剥掉末尾的零，破坏逐字节比较）。

错误码：路线不在表里 → `METHOD_NOT_FOUND`（TAPI-24 §3.2 明文要求）；`amountIn` 非正整数串或超过 `maxAmountIn` → `BAD_REQUEST`；`ttl` 不在 30..120 → `BAD_REQUEST`。

## `SOLVER_KEY` 与 `SIGNER_KEY` 是两把不同的钥匙

| | `SIGNER_KEY` → `signer` | `SOLVER_KEY` → `solver` |
|---|---|---|
| 签什么 | TAPI-21 响应信封（整个 `result`） | 报价结构体（EIP-712，TAPI-24 §3.3） |
| 谁来验 | 客户端，按 TAPI-20 的委托链回到容器 | `fromChain` 上的 `IntentEscrow`，一次 `ecrecover` |
| 算法 | EIP-191（`personal_sign` 前缀） | **EIP-712，没有任何前缀** |
| 拿到什么 | 服务身份、可归属、可计费 | 锁在托管里的 `amountIn` |

理由是 TAPI-24 §4 的第一条 Rationale：**`fromChain` 上的托管合约无法验证一条根植于 chainId 56 的 TAPI-20 委托。** 它只能做一次 `ecrecover`，所以报价必须由一把在 `fromChain` 上"就是一个普通地址"的钥匙签。信封签名并没有因此失去意义：它把这份报价绑到服务身份上，用于发现、归属与争议。

两把钥匙都可以不设（各自生成临时密钥，**私钥都不打印**）；`SOLVER_KEY` 不设时 `solver` 地址每次启动都会变，固定下来才能被人持续询价。两把设成同一个值会打印警告。

## 完整的报价验证走查（两层签名都要验）

```js
import { sig, abi } from '@tapeapi/sdk'

const id = 'q-1'
const method = 'quote'
const params = { fromChain: 56, fromToken: '0x55d3…7955', amountIn: '1000000000000000000000',
                 toChain: 8453, toToken: '0x8335…2913', recipient: '0x…dEaD', ttl: 60 }
const env = await (await fetch(`${endpoint}/${method}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, params }),
})).json()
const { quote, sig: quoteSig, domain, escrow, typehash, digest } = env.result

// ── 第一层：报价的 EIP-712 签名（TAPI-24 §3.3，链上 IntentEscrow 验的就是这一层）──────────────
const TYPE = 'Quote(bytes32 quoteId,uint64 fromChain,address fromToken,uint256 amountIn,uint64 toChain,address toToken,uint256 amountOut,address recipient,uint64 expires,address solver)'
const TH = abi.toHex(abi.keccak256(TYPE))                       // 自己算，别信对方给的
if (TH !== '0xe7c18a58c429974068166f7c27b8ba2a9a13177c83aeb69cdcac7a4bc7592d59') throw new Error('typehash')
if (TH !== typehash) throw new Error('solver reported a different typehash')

const structHash = abi.keccak256(abi.encodeParams(
  ['bytes32','bytes32','uint64','address','uint256','uint64','address','uint256','address','uint64','address'],
  [TH, quote.quoteId, quote.fromChain, quote.fromToken, quote.amountIn,
   quote.toChain, quote.toToken, quote.amountOut, quote.recipient, quote.expires, quote.solver]))

// domain 也要自己核：chainId 必须是 fromChain，verifyingContract 必须是 fromChain 上的 IntentEscrow
if (domain.name !== 'IntentEscrow' || domain.version !== '1') throw new Error('domain')
if (domain.chainId !== quote.fromChain) throw new Error('domain.chainId must equal quote.fromChain')
if (domain.verifyingContract.toLowerCase() !== escrow.toLowerCase()) throw new Error('domain.verifyingContract must be the escrow')

const d = abi.toHex(sig.typedDigest(domain, structHash))        // keccak256(0x1901 ‖ DOMAIN_SEPARATOR ‖ structHash)
if (d !== digest) throw new Error('digest mismatch')
const recovered = sig.recoverAddress(d, quoteSig)               // SDK 已强制低 s 并要求 v ∈ {27,28}
if (recovered.toLowerCase() !== quote.solver.toLowerCase()) throw new Error('quote sig does not recover to quote.solver')
if (quote.expires <= Math.floor(Date.now() / 1000) + 10) throw new Error('quote expires too soon to use')

// ── 第二层：TAPI-21 信封签名（把这份报价绑到服务身份）────────────────────────────────────────
const envelopeSigner = sig.recoverResponseSigner(
  { container: env.container, id, method, params, ok: env.ok, body: env.result, ts: env.ts }, env.sig)
const manifest = await (await fetch(`${origin}/.well-known/tapeapi.json`)).json()
if (envelopeSigner.toLowerCase() !== manifest.signer.toLowerCase()) throw new Error('envelope signer mismatch')
// 生产环境还要按 TAPI-20 验 manifest.delegation：holder 签给 (container, signer, expires) 的那条委托。
```

注意 `envelopeSigner`（= `manifest.signer`）与 `quote.solver` **本来就应当是两个不同的地址**，见上一节。第一层决定"托管会不会放钱给他"，第二层决定"出了事找谁"。

## 多个 Solver 并发询价，各自验签，挑最优

**不要用 `callQuorum`。** RFQ 的正确模式是并发问、逐个验、按 `amountOut` 挑最大：

```js
import { createTapeAPI } from '@tapeapi/sdk'
const api = createTapeAPI({ rpcUrls, quorum: 2, directory, escrow })
const solvers = await Promise.all(['solver-a', 'solver-b', 'solver-c'].map(l => api.resolve(l)))
const params = { fromChain: 56, fromToken, amountIn, toChain: 8453, toToken, recipient, ttl: 60 }

const settled = await Promise.allSettled(solvers.map(s => api.call(s, 'quote', params)))
const usable = []
for (const r of settled) {
  if (r.status !== 'fulfilled' || !r.value.ok) continue          // METHOD_NOT_FOUND = 这家不做这条路线
  try { verifyQuoteEnvelope(r.value, params) } catch { continue } // 上一节那三十行，一家都不能跳过
  usable.push(r.value)
}
if (!usable.length) throw new Error('no usable quote')
usable.sort((a, b) => (BigInt(b.result.quote.amountOut) - BigInt(a.result.quote.amountOut) > 0n ? 1 : -1))
const best = usable[0]                                           // 收得最多的那家；BigInt 比较，不要用 Number
// 接下来：拿 best.result.quote + best.result.sig 去 fromChain 上调 IntentEscrow.lock(...)
// —— 但 IntentEscrow 还没部署，本示例到此为止。
```

一家报价慢或报错不会拖垮整轮（`allSettled`），也不会有"多数决"：**每一份报价都是独立成立或独立作废的**。

## TAPI-24 §3.5 的五步流程，以及本示例走到哪一步

1. **用户向多家 Solver 调 `quote` 并选定一个。** ← **本示例实现了这一步**（`quote` + 上面两节的验证与挑选）。
2. 用户在 `fromChain` 上以报价、`solverSig` 与自选的见证者集合调 `IntentEscrow.lock`。 ← **`IntentEscrow` 未部署，本示例到此为止。**
3. Solver 观察到 `Locked`，确认见证者集合可信，在 `q.expires` 前于 `toChain` 调 `pay`。 ← 本示例没有实现（没有库存，也没有可付款的托管）。
4. 任何人向见证者请求对 `paid[quoteId]` 的 TAPI-23 读取（钉到已最终确认的块），在 `fromChain` 上提交 `fulfil`。 ← **`IntentEscrow` 未部署，本示例到此为止。**
5. 若第 4 步未在 `q.expires + REFUND_DELAY` 前成功，用户调 `refund`。 ← 同上。

`status()` 只反映第 1 步：它是本进程内存里的报价簿（LRU，上限 10000 条），`onChain` **恒为 `null`**，`note` 恒为 `"IntentEscrow is not deployed; this is local bookkeeping only"`。进程重启后一切归零。

## 安全提示

- **`expires` 取 30–120 秒**（TAPI-24 §3.3，本示例默认 60、越界 `BAD_REQUEST`）。一份签名报价就是一份免费期权：过期越长，做市商被用户"择时行权"的损失越大。业界的硬上界见下一节。
- **`quoteId` 每个 Solver 必须唯一**，本示例按 TAPI-24 §3.3 的推荐用 `keccak256(solver ‖ random32)`。托管合约靠它拒绝重复 `lock`。
- **重放防护来自域**（TAPI-24 §8）：`chainId` 与 `verifyingContract` 都进了 `DOMAIN_SEPARATOR`，所以同一份报价在另一条链、另一个托管上算出的 `digest` 不同，签名自然验不过——`quote.test.mjs` 对这两条各有一个回归用例。
- **低 s 与 `v ∈ {27,28}`**：SDK 的 `sig.signDigest` 强制低 s，`sig.recoverAddress` 拒绝高 s。高 s 签名在链上 `ECDSA.recover` 会被拒，离线也不该接受。

## 与真实 RFQ 协议的对照（也是给 TAPI-24 的反馈）

全行业只有两家给出"可链上验证、零滑点的固定报价"，两家都把报价绑定到三样东西：**特定对手方、一次性 id/nonce、以秒计的短过期**。TAPI-24 §3.3 目前只做到了后两样。

| | 0x RFQ（`RfqOrder`） | Hashflow（`RFQTQuote`） | TAPI-24 §3.3 `Quote`（本示例） |
|---|---|---|---|
| 签名 | EIP-712，typehash `0xe593d3fd…7da9` | **EIP-191**（`abi.encodePacked` 摘要，含 `block.chainid` 与 pool 地址） | EIP-712，typehash `0xe7c1…2d59` |
| 绑定提交者 | **`txOrigin`（必填）**——只有该 EOA 发起的交易才能成交 | `effectiveTrader` + 一次性 `txid`（router 维护 `_usedTxids`） | **无** |
| 绑定接收者 | `taker`（0 = 任意） | `trader` / `effectiveTrader` 分离 | `recipient` |
| 过期 | `expiry` uint64 秒 | `quoteExpiry` 秒，且 `nonce ≤ (block.timestamp + 180) * 1000` | `expires` uint64 秒 |
| 报价响应时限 | 未公布 | **做市商须在收到 `rfqT` 后 750 ms 内回 `rfqTQuote`** | 未定义 |
| 部分成交 | 否 | **按比例**：`effectiveBaseTokenAmount` 缩小时 `quoteTokenAmount` 等比缩放，**签名的汇率不变、无需重签** | 未定义 |

三条结论：

- **TAPI-24 缺一个 `txOrigin` 等价物。** 没有它，签名报价在 mempool 里对任何人可见即可用（只要 `lock` 的调用者能构造相同参数），Solver 等于免费送出一份期权。实现者可以在 `quote` 的 `params` 里另接一个可选的 `submitter` 并签进结构体——但那会改变主类型字符串和 `QUOTE_TYPEHASH`，所以**必须先补进 TAPI-24**，不能各家自己加。本示例没有实现，**记为"待 TAPI-24 补齐"**。
- **TAPI-24 缺 `effectiveTrader` 分离。** 一旦有路由合约夹在用户与托管之间，`recipient` 就不再是"谁在重放"的正确账本键：路由合约会成为所有意图的 `recipient`，真实用户消失在账本外。
- **TAPI-24 的 `expires` 30–120 s 与业界一致。** Hashflow 的硬上界是 180 s，Velora Delta 文档示例 1800 s，Across 的 `fillDeadline − timestamp` 实测 7200 s；越是"固定价格承诺"越短，越是"意图/拍卖"越长。本示例默认 `ttl = 60` 合理。

## 什么时候不要用这个

**这是骨架，不是做市商。** 它没有库存、没有对冲、没有价格来源，只有一张固定汇率表。按它的报价真去打款，亏的是打款的人。上线之前，`quote.mjs` 的 `priceAmountOut` 必须换成真实的报价引擎，`inventory` 必须接真实的持仓与风险限额。

**单提供者的签名响应不能当借贷协议的主价格喂价**。理由不是"一个签名不够"，而是更硬的三条：TAPI-23 §3.4 的法定人数规则是**写给客户端的**，而清算逻辑在链上，`Comptroller` 里没有 `callQuorum`；TAPI-23 §3.6 把质押与罚没明确留给未来的 TAP，并要求客户端 MUST NOT 假设任何提供者有质押——签错价的提供者今天的损失上限只是声誉，对面却是一次可能几百万美元的清算激励；出了事在链上没有承受者。

Chainlink 自己就是这么说的（docs.chain.link/data-feeds/selecting-data-feeds 原话）：

> **"Ultimately you are responsible for identifying and assessing the accuracy, availability, and quality of data that you choose to consume via the Chainlink Network."**
> **"Users of single-source feeds MUST implement additional safeguards such as value bounds, caps, circuit breakers, freshness checks, fallback behavior, monitoring against independent references where available, and manual pause or kill-switch controls."**

**一个 TapeAPI 提供者就是一个 single-source feed。** 按 Chainlink 自己的标准，使用它的协议必须外加**价值界限、上限、熔断、新鲜度检查、回退行为、与独立参照的对照监控，以及人工暂停/kill switch**。这不是贬低 TapeAPI，这是它能被正当使用的前提条件。

另外**不要**把它放进任何毫秒级竞速路径（竞速清算、抢跑预言机更新需要区块内延迟，HTTPS + 签名信封结构上进不去），也不要对任何 `[no-quorum]` 方法使用"取多数"或"取平均"的聚合语义——TAPI-23 §3.4 的规则是**有分歧即拒绝，绝不取多数**。

## 从 dev 到主网

1. **铸电路**：在 TapeOut 铸一个电路 NFT → `circuits`/`tokenId`，容器 = `DeWebHub.accountOf(circuits, tokenId)`。
2. **签委托**：`examples/reader-service/sign-delegation.mjs`（holder 私钥、容器、启动时打印的 `signer`、过期时间；`--hub` 默认主网 DeWebHub，**不是** ServiceDirectory）。
3. **带这些环境变量重启**：`DELEGATION_SIG`、`DELEGATION_EXPIRES`、`SIGNER_KEY`（设了委托就必须设，否则直接退出）、`CONTAINER`、`CIRCUITS`、`TOKEN_ID`、`ESCROW`、`PUBLIC_URL`。清单会自动变成 `dev: false`。
4. **另外设 `SOLVER_KEY`**（与 `SIGNER_KEY` 不同的一把），否则 `solver` 地址每次重启都变、询价方无法持续找到你。
5. **把 `quote.config.json` 的 `escrow` 换成真实的 `IntentEscrow` 地址**——今天没有，TAPI-24 §6 的表里写着 `TODO (not deployed)`。在那之前第 4、5 两步之后的链上流程都跑不起来。
6. **发布清单**：把 `GET /.well-known/tapeapi.json` 写到容器 DeWEB 站点；`api.tx.register({ circuits, tokenId, label: 'solver-a', manifestPath })` 注册别名。

环境变量：`PORT`、`SIGNER_KEY`、`SOLVER_KEY`、`RPC_URLS`、`QUORUM`、`CHAIN_ID`、`BLOCK_LAG`、`CONTAINER`、`CIRCUITS`、`TOKEN_ID`、`ESCROW`、`DELEGATION_SIG`、`DELEGATION_EXPIRES`、`PUBLIC_URL`、`FREE_ALL`（仅 dev）、`QUOTE_CONFIG`。

---

# defi-rfq-solver — a TAPI-24 Solver reference skeleton

> This example has **no real inventory, no market-making ability and no risk management**. It uses a configurable fixed price table plus a fixed spread to produce **well-formed** EIP-712 signed quotes, so that the typehash, digest, signature recovery and expiry semantics of TAPI-24 §3.3 can be exercised, along with the whole client-side path while `IntentEscrow` does not yet exist.
> **Anyone who pays against these quotes loses money.** `IntentEscrow` is explicitly marked in TAPI-24 §7 as a v0.4 deliverable that does not exist today (`spec/TAPI-24.md` §6: "IntentEscrow address (CREATE2) | TODO (not deployed)"), so the `escrow` field returns the placeholder address from the config, and the fill state reported by `status()` comes from **local memory**, not from any on-chain fact.

## What it is

A TapeAPI service on `:8794` implementing the `quote` method of TAPI-24 §3.2 plus three helpers. Its purpose is to give TAPI-24 implementers **something that runs and that can be checked byte for byte**:

- The quote's EIP-712 domain, primary type, `structHash`, `digest` and 65-byte signature are built exactly per TAPI-24 §3.3, and are self-checked at start-up against the test vectors of `spec/TAPI-24.md` §6 (`keccak256(<type string>)` must equal `QUOTE_TYPEHASH`, and `keccak256("IntentEscrow")` must equal the domain-name hash). **A mismatch refuses to start.**
- Both signature layers are verifiable: the quote itself is signed by the `solver` key under EIP-712 (what an on-chain `ecrecover` checks), and the whole `result` is additionally covered by the TAPI-21 envelope signature (which binds it to the service identity).
- Pricing is BigInt throughout, truncated toward zero; the formula's parameters live in `quote.config.json`.

All pure logic lives in `quote.mjs` (pricing, EIP-712, validation, the quote book); `index.mjs` only does env, chain reads and HTTP; `quote.test.mjs` tests `quote.mjs` directly — the unit tests **never open a socket and never touch the network**. Same layering as `examples/web2-adapter/adapter.mjs`.

## Run in three steps

```sh
npm install --no-audit --no-fund                        # once, in tapeapi/
node examples/defi-rfq-solver/index.mjs                 # :8794; SOLVER_KEY=0x.. pins the solver address
curl -s -X POST http://127.0.0.1:8794/tapeapi/v1/routes -H 'content-type: application/json' -d '{"id":"1","params":{}}'
```

The start-up log prints the `solver` address, the `signer` address and the self-checked typehash. Neither private key is ever printed.

## Methods: what can enter a quorum and what cannot

| method | price | quorum | what |
|---|---|---|---|
| `quote({fromChain,fromToken,amountIn,toChain,toToken,recipient,ttl?})` | free | **`[no-quorum]`** | An EIP-712 signed quote. **Do not put this in `callQuorum`; it will always `QUORUM_FAILED`.** |
| `routes({})` | free | **`[no-quorum]`** | The routes this solver serves and its quoting parameters. **Do not put this in `callQuorum`; it will always `QUORUM_FAILED`.** |
| `status({quoteId})` | free | **`[no-quorum]`** | The **in-memory** state of one `quoteId`. **Do not put this in `callQuorum`; it will always `QUORUM_FAILED`.** |
| `inventory({chainId,tokens,block?})` | free | `[quorum]` (conditionally) | Balances of the `solver` address at a pinned block, with `blockPinned`. |

**Why `quote` cannot enter a quorum.** TAPI-24 §3.3 requires `quoteId` to be unique per quote (RECOMMENDED `keccak256(solver ‖ random32)`) and `expires` to be an absolute time 30–120 s out. Two calls — let alone two solvers — **necessarily** produce different bytes, while `callQuorum` accepts only byte-identical `canonicalJSON(result)`. This is not a defect: **the semantics of RFQ is that the user picks one of several quotes, not that several parties give the same answer.**

**The label on `routes`: the original example specification was wrong.** It labelled `routes` `[quorum]`. That is incorrect and this example labels it `[no-quorum]`. Either of two reasons suffices: per TAPI-23, a quorum-able method must accept an explicit `block` and always return the pinned block in its result, and `routes` takes no params and pins no block; and it returns `solver`, which is each instance's own address, so two independent solvers can never match.

**`inventory` is `[quorum]`, but only in one situation.** It does pin a block (`finalized` when `block` is omitted, evaluated by EIP-1898 `{blockHash, requireCanonical:true}`), so the block-anchoring half holds. But it also returns `solver`: **two genuinely independent solvers can never agree byte for byte**, because their `solver` addresses differ. It is quorum-able only **across mirrors of one and the same solver sharing a single `SOLVER_KEY`** — then the replicas are several endpoints of one identity and `solver`, `balances` and `blockPinned` can be identical. For the quorum round, send the same **explicit numeric `block`** to every mirror, per TAPI-23 §3.4 — and do it **promptly**: public BSC dataseed nodes keep state for a short window only. Measured here, a `finalized` block read fine at roughly one minute old and returned `missing trie node` (`RPC_ERROR`) at roughly three minutes old. A late mirror gives you a failure, not a disagreement.

## curl

```sh
curl -s -X POST http://127.0.0.1:8794/tapeapi/v1/quote -H 'content-type: application/json' -d '{
  "id":"q-1",
  "params":{"fromChain":56,
            "fromToken":"0x55d398326f99059fF775485246999027B3197955",
            "amountIn":"1000000000000000000000",
            "toChain":8453,
            "toToken":"0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
            "recipient":"0x000000000000000000000000000000000000dEaD",
            "ttl":60}}' | jq .
# actual response (1000 USDT in -> 997 USDC out: 30 bps spread, 18 decimals -> 6 decimals)
# — see the annotated output in the Chinese half above; `amountOut` is "997000000".

curl -s -X POST http://127.0.0.1:8794/tapeapi/v1/status -H 'content-type: application/json' \
  -d '{"id":"s-1","params":{"quoteId":"0x72b6…363b"}}' | jq '.result | {state,expires,onChain,note}'
# { "state": "quoted", "expires": 1789920439, "onChain": null,
#   "note": "IntentEscrow is not deployed; this is local bookkeeping only" }
```

The field names and order of `result.quote` match the primary type of TAPI-24 §3.3 **exactly**: `{quoteId, fromChain, fromToken, amountIn, toChain, toToken, amountOut, recipient, expires, solver}` — `abi.encode` follows that order, and changing it changes the `digest`. `amountIn`/`amountOut` are always **decimal strings in the smallest unit**, never a fixed-point rendering. (Fixed-point strings appear only in `inventory.balances[].formatted` and `routes`' `maxAmountInFormatted`, produced by `fixed()` from `examples/_lib/codec.mjs`, because the SDK's `formatUnits` strips trailing zeros and would break byte-for-byte comparison.)

Errors: a route not in the table → `METHOD_NOT_FOUND` (required in so many words by TAPI-24 §3.2); `amountIn` that is not a positive integer string, or above `maxAmountIn` → `BAD_REQUEST`; `ttl` outside 30..120 → `BAD_REQUEST`.

## `SOLVER_KEY` and `SIGNER_KEY` are two different keys

| | `SIGNER_KEY` → `signer` | `SOLVER_KEY` → `solver` |
|---|---|---|
| signs | the TAPI-21 response envelope (the whole `result`) | the quote struct (EIP-712, TAPI-24 §3.3) |
| verified by | clients, following the TAPI-20 delegation back to the container | the `IntentEscrow` on `fromChain`, with one `ecrecover` |
| algorithm | EIP-191 (`personal_sign` prefix) | **EIP-712, no prefix at all** |
| what it buys | service identity, attribution, metering | the `amountIn` locked in escrow |

The reason is the first Rationale bullet of TAPI-24 §4: **the escrow on `fromChain` cannot verify a TAPI-20 delegation rooted on chainId 56.** It can only do one `ecrecover`, so the quote must be signed by a key that is "just an address" on `fromChain`. The envelope signature does not become pointless: it binds the quote to the service identity for discovery, attribution and disputes.

Either key may be left unset (an ephemeral key is generated; **neither private key is ever printed**). With `SOLVER_KEY` unset the `solver` address changes on every restart, so pin it if you want to be quotable over time. Setting both to the same value prints a warning.

## A complete quote verification walkthrough (verify both layers)

See the annotated JavaScript in the Chinese half above — it is the same code. In summary:

1. **Layer 1, the EIP-712 quote signature.** Recompute `TH = keccak256(<type string>)` yourself and check it equals `0xe7c1…2d59` *and* the `typehash` the solver reported. Build `structHash = keccak256(abi.encode(TH, quoteId, fromChain, fromToken, amountIn, toChain, toToken, amountOut, recipient, expires, solver))`. Check the domain yourself: `name === "IntentEscrow"`, `version === "1"`, `chainId === quote.fromChain`, `verifyingContract === escrow`. Then `digest = keccak256(0x1901 ‖ DOMAIN_SEPARATOR ‖ structHash)` (`sig.typedDigest`), compare with the reported `digest`, and require `sig.recoverAddress(digest, sig) === quote.solver`. The SDK already rejects high-s and any `v ∉ {27,28}`. Finally require `quote.expires` to be comfortably in the future.
2. **Layer 2, the TAPI-21 envelope signature.** `sig.recoverResponseSigner({ container, id, method, params, ok, body: result, ts }, env.sig)` must equal `manifest.signer`, and in production the manifest's `delegation` must check out per TAPI-20.

`envelopeSigner` (= `manifest.signer`) and `quote.solver` **are supposed to be two different addresses**, per the section above. Layer 1 decides whether the escrow will release funds to them; layer 2 decides whom you go after when something goes wrong.

## Ask several solvers concurrently, verify each, take the best

**Do not use `callQuorum`.** The correct RFQ pattern is to ask in parallel, verify each answer on its own, and take the largest `amountOut`:

```js
const settled = await Promise.allSettled(solvers.map(s => api.call(s, 'quote', params)))
const usable = []
for (const r of settled) {
  if (r.status !== 'fulfilled' || !r.value.ok) continue          // METHOD_NOT_FOUND = this solver skips the route
  try { verifyQuoteEnvelope(r.value, params) } catch { continue } // both layers, for every single quote
  usable.push(r.value)
}
if (!usable.length) throw new Error('no usable quote')
usable.sort((a, b) => (BigInt(b.result.quote.amountOut) - BigInt(a.result.quote.amountOut) > 0n ? 1 : -1))
const best = usable[0]                                           // BigInt comparison, never Number
// next: take best.result.quote + best.result.sig to IntentEscrow.lock(...) on fromChain
// — but IntentEscrow is not deployed, so this example stops here.
```

A slow or failing solver does not sink the round (`allSettled`), and there is no majority vote: **each quote stands or falls on its own.**

## The five-step flow of TAPI-24 §3.5, and where this example stops

1. **The user calls `quote` on several Solvers and picks one.** ← **this example implements this step** (`quote`, plus the verification and selection above).
2. The user calls `IntentEscrow.lock` on `fromChain` with the quote, `solverSig` and its chosen attesters. ← **IntentEscrow not deployed, this example stops here.**
3. The Solver observes `Locked`, checks it trusts the attester set, and calls `pay` on `toChain` before `q.expires`. ← not implemented (no inventory, and no escrow to pay through).
4. Anyone requests TAPI-23 reads of `paid[quoteId]` from the attesters (pinned to a finalized block) and submits `fulfil` on `fromChain`. ← **IntentEscrow not deployed, this example stops here.**
5. If step 4 does not succeed before `q.expires + REFUND_DELAY`, the user calls `refund`. ← same.

`status()` only reflects step 1: it is this process's in-memory quote book (an LRU capped at 10000 entries), `onChain` is **always `null`**, and `note` is always `"IntentEscrow is not deployed; this is local bookkeeping only"`. A restart wipes it.

## Security notes

- **Use `expires` of 30–120 s** (TAPI-24 §3.3; this example defaults to 60 and rejects anything outside the range with `BAD_REQUEST`). A signed quote is a free option: the longer it lives, the more the market maker loses to users exercising it at the right moment.
- **`quoteId` MUST be unique per Solver**; this example follows the TAPI-24 §3.3 recommendation, `keccak256(solver ‖ random32)`. The escrow uses it to reject a duplicate `lock`.
- **Replay protection comes from the domain** (TAPI-24 §8): both `chainId` and `verifyingContract` go into the `DOMAIN_SEPARATOR`, so the same quote on another chain or against another escrow produces a different `digest` and the signature simply does not verify. `quote.test.mjs` has a regression case for each.
- **Low-s and `v ∈ {27,28}`**: the SDK's `sig.signDigest` forces low-s and `sig.recoverAddress` rejects high-s. A high-s signature is rejected by the on-chain `ECDSA.recover`, so it must not be accepted off-chain either.

## Compared with real RFQ protocols (also feedback for TAPI-24)

Only two protocols in the industry offer "an on-chain-verifiable, zero-slippage fixed quote", and both bind the quote to three things: **a specific counterparty, a one-shot id/nonce, and a short expiry measured in seconds**. TAPI-24 §3.3 currently has only the last two. The comparison table is in the Chinese half; the three conclusions are:

- **TAPI-24 lacks a `txOrigin` equivalent.** Without one, a signed quote visible in the mempool is usable by anyone who can reconstruct the same `lock` parameters, and the Solver has given away a free option. An implementer could accept an optional `submitter` in `params` and sign it into the struct — but that changes the primary-type string and therefore `QUOTE_TYPEHASH`, so it **must land in TAPI-24 first** rather than being added per-solver. Not implemented here; **recorded as "pending in TAPI-24"**.
- **TAPI-24 lacks the `effectiveTrader` separation.** As soon as a router contract sits between the user and the escrow, `recipient` is no longer the correct ledger key for "who is replaying": the router becomes the `recipient` of every intent and the real user disappears from the ledger.
- **TAPI-24's 30–120 s `expires` matches the industry.** Hashflow's hard ceiling is 180 s, the Velora Delta docs example is 1800 s, and Across's measured `fillDeadline − timestamp` is 7200 s: the firmer the price commitment, the shorter the window; the more auction-like the intent, the longer. The default `ttl = 60` here is reasonable.

Two further gaps the table shows, both undefined in TAPI-24: Hashflow requires a market maker to answer an `rfqT` within **750 ms** (TAPI-24 defines no quoting deadline at all), and Hashflow supports **pro-rata partial fills** — when `effectiveBaseTokenAmount` comes in below `baseTokenAmount`, `quoteTokenAmount` scales down in proportion while **the signed rate is unchanged and no re-signing is needed**. TAPI-24's `Quote` is all-or-nothing: `amountIn` and `amountOut` are fixed, so a partial `lock` has no signed meaning.

## When not to use this

**This is a skeleton, not a market maker.** It has no inventory, no hedging and no price source — only a fixed rate table. Pay against its quotes and the money is gone. Before any real deployment, `priceAmountOut` in `quote.mjs` must be replaced by a real quoting engine and `inventory` must be wired to real positions and risk limits.

**A single-provider signed response is not a lending protocol's primary price feed**. The reason is harder than "one signature is not enough". The quorum rule of TAPI-23 §3.4 is a **client-side** rule, while liquidation logic lives on-chain and `Comptroller` has no `callQuorum`. TAPI-23 §3.6 leaves staking and slashing to a future TAP and requires that clients MUST NOT assume any provider is staked — a provider that signs a wrong price risks only its reputation today, against a liquidation incentive that can run into millions. And on-chain, nobody bears the liability.

Chainlink says as much about its own feeds (docs.chain.link/data-feeds/selecting-data-feeds):

> **"Ultimately you are responsible for identifying and assessing the accuracy, availability, and quality of data that you choose to consume via the Chainlink Network."**
> **"Users of single-source feeds MUST implement additional safeguards such as value bounds, caps, circuit breakers, freshness checks, fallback behavior, monitoring against independent references where available, and manual pause or kill-switch controls."**

**One TapeAPI provider is a single-source feed.** By Chainlink's own standard, a protocol consuming it must add **value bounds, caps, circuit breakers, freshness checks, fallback behaviour, monitoring against independent references, and a manual pause / kill switch**. That is not a criticism of TapeAPI; it is the precondition for using it legitimately.

Also **do not** put this in any millisecond-latency race (competitive liquidation and oracle front-running need intra-block latency, which HTTPS plus a signed envelope structurally cannot reach), and never apply "take the majority" or "take the average" aggregation to any `[no-quorum]` method — the rule of TAPI-23 §3.4 is **any disagreement is a rejection, never a majority**.

## Dev to mainnet

1. **Mint a circuit** on TapeOut → `circuits`/`tokenId`; container = `DeWebHub.accountOf(circuits, tokenId)`.
2. **Sign the delegation** with `examples/reader-service/sign-delegation.mjs` (holder key, container, the printed `signer`, expiry; `--hub` defaults to the mainnet DeWebHub — **not** a ServiceDirectory).
3. **Restart with** `DELEGATION_SIG`, `DELEGATION_EXPIRES`, `SIGNER_KEY` (required once a delegation is set — the process exits without it), `CONTAINER`, `CIRCUITS`, `TOKEN_ID`, `ESCROW`, `PUBLIC_URL`. The manifest flips to `dev: false` by itself.
4. **Also set `SOLVER_KEY`** (a different key from `SIGNER_KEY`), or the `solver` address changes on every restart and nobody can keep quoting against you.
5. **Replace `escrow` in `quote.config.json` with the real `IntentEscrow` address** — which does not exist today; TAPI-24 §6 says `TODO (not deployed)`. Until then, nothing after step 1 of the five-step flow can run.
6. **Publish the manifest** served at `/.well-known/tapeapi.json` to the container's DeWEB site, and register the label: `api.tx.register({ circuits, tokenId, label: 'solver-a', manifestPath })`.

Env: `PORT`, `SIGNER_KEY`, `SOLVER_KEY`, `RPC_URLS`, `QUORUM`, `CHAIN_ID`, `BLOCK_LAG`, `CONTAINER`, `CIRCUITS`, `TOKEN_ID`, `ESCROW`, `DELEGATION_SIG`, `DELEGATION_EXPIRES`, `PUBLIC_URL`, `FREE_ALL` (dev only), `QUOTE_CONFIG`.
