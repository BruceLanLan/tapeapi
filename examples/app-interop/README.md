# 应用互通示例 / App interop example (local demo)

**只在本地。** 全部在 SDK 的**假链**上运行（测试辅助：进程内的 JSON-RPC，任何真链上都没有，也不出本进程），密钥都是假链夹具。付费部分用的 TAPI-22 托管合约**未审计、未部署**，这里是它的**模型**；**主网上今天不能用**。示例不在 npm 包里。

**Local only.** Everything runs on the SDK's **fake chain** (a test helper: an in-process JSON-RPC; nothing is on any real chain and nothing leaves the process), with the fake chain's fixture keys. The paid part uses the TAPI-22 escrow, which is **neither audited nor deployed**; here it is a **model** of it, and **it cannot be used on mainnet today**. The example is not in the npm package.

## 这是什么 / What this is

两个"应用"加一个用户钱包：

- **应用 A**（调用方，`app-a.mjs`，容器 #12，名字 `12.7.tape`）：一个 DeWEB 页面或任何应用。它用 TapeAPI SDK 按名字找到 B、从链上读 B 的清单、调用 B 的方法，并**自己核验** B 的签名回答。A 调用别人不需要钥匙。
- **应用 B**（被调用方，`app-b.mjs`，容器 #13，名字 `13.7.tape`）：两个方法，`profile` 免费，`quote` 每次 0.0001 BEM。B 的清单是 **B 自己站点里的一个文件**（`.well-known/tapeapi.json`，与网页同一个容器）；B 的签名端点 `https://app-b.example` 由 `createProvider` 在进程内提供。
- **用户 U**：一个普通钱包（没有容器）。它签三笔交易，允许 A 在上限内替它调用 B 的收费方法；它也可以签一份**访客授权**（下文，实验性），让 A 读取它在 B 的数据，B 因此认得出调用方是 A。

Two "apps" and one user wallet:

- **App A** (the caller, `app-a.mjs`, container #12, name `12.7.tape`): a DeWEB page or any app. It uses the TapeAPI SDK to find B by name, read B's manifest from the chain, call B's methods and **check B's signed answers itself**. A needs no key to call anyone.
- **App B** (the called app, `app-b.mjs`, container #13, name `13.7.tape`): two methods, `profile` free and `quote` at 0.0001 BEM a call. B's manifest is **a file of B's own site** (`.well-known/tapeapi.json`, the same container as its pages); B's signing endpoint `https://app-b.example` is served in process by `createProvider`.
- **User U**: a plain wallet (no container). It signs three transactions that let A call B's priced method for it, within a cap; it can also sign a **visitor grant** (below, experimental) that lets A read its own data at B, so that B can tell the caller is A.

## 跑法 / Run

在仓库根目录（先 `npm install --no-audit --no-fund` 一次），Node 22+。不联网、不花钱、不碰真实钱包。
From the repository root (`npm install --no-audit --no-fund` once), Node 22+. No network, no cost, no real wallet.

```bash
node examples/app-interop/demo.mjs                 # the whole story, printed / 打印整个过程
node --test examples/app-interop/*.test.mjs        # the tests (also part of npm test) / 测试（也在 npm test 里）
```

## 访客授权（实验性）/ The visitor grant (experimental)

**这是原型，不是规范，也不是 TAP；没有任何服务认识这个格式。** 实现在实验性的独立包 `@tapeapi/interop`（不受兼容承诺约束），服务端只多给处理器一个只读的 `ctx.request`，以及为同 id 重试原样重发回答的 `ctx.onSigned` / `ctx.resend`（都是实验性；签名与计费不变）。

1. A 在自己的源里生成一次性调用钥匙 K；按链上读取得到 A 自己的容器与持有人、B 的持有人（不信任何自述），生成授权书 `VisitorGrant`：两个名字、方法、次数上限（1–10,000）、有效期（默认 1 小时，最长 7 天）、随机 nonce，以及**由字段自动生成**的第一行人话 `statement`，例如："Allow 12.7.tape to call these methods of 13.7.tape on my behalf: history. At most 5 calls, valid from … to … UTC. This grant includes no payment. Revocable at any time with 13.7.tape."
2. 访客钱包按 EIP-712 签它（独立的域 "TapeAPI Visitor Grant"，不是 TAP-11 的 "TapeAPI" 域）。**访客只需核对一件事：第一行里的调用方名字，与钱包顶部"请求来自"的站点是不是同一个。**
3. A 每次请求在请求顶层加 `grant`（授权书 + 访客签名 + 用 K 签的调用证明，证明覆盖 B、授权哈希、请求 id 与请求哈希）。
4. B 按固定顺序核验，廉价的在前、读链的在后（受众是自己（容器与名字）、方法在范围内且清单标了 `grant`、时间窗、`statement` 逐字重建、撤销表、调用证明、重放、访客签名（含 EIP-1271）、B 自己当前的持有人与站点状态、A 的名字与持有人、不与付款凭证并存、计数），全部成立后在**签名回答**里写入 `result.grant = { hash, caller, user, used, maxCalls }`。A 看不到这份记录就判失败（`GRANT_NOT_HONOURED`）。
5. 撤销：到期；或访客签 `GrantRevocation` 投递到 B 的免费方法 `grant_revoke`，B 的签名回答就是回执。
6. 拒绝一律是 TAP-13 的 `BAD_REQUEST`，原因写在 message 前缀 `grant: <原因>`，**不带 `error.data`**；新错误码要等有 TAP。

**边界**：任何跨应用调用都是链下请求，站点因此不再是"100% 链上"；撤销与计数只由被调用方执行，对恶意服务无效；回执证明 B 签了什么，不证明数据正确；在外壳把关之前，用户要自己比对钱包里"请求来自"的站点与授权里的调用方名字；授权书不含任何付款（带授权的请求不得同时带付款凭证）；付费调用依赖的托管合约未审计、未部署，主网不可用。钱包在网关下如何显示这份类型数据**没有实测**；本机测试页与操作清单在 [`wallet-render/`](wallet-render/CHECKLIST.zh.md)（空钱包、不发交易，实测尚未做）。

**This is a prototype, not a specification and not a TAP; no service knows this format.** The code is the experimental package `@tapeapi/interop`, its own package next to the SDK (outside the compatibility promise); the server only gives handlers a read-only `ctx.request`, and `ctx.onSigned` / `ctx.resend` to send an answer again for a retry of the same id (all experimental; nothing it signs or bills changes).

1. A makes a one-off call key K in its own origin; reads from the chain its own container and holder and B's holder (trusting nothing the request says); builds a `VisitorGrant`: the two names, the methods, a call cap (1–10,000), a validity (1 hour by default, 7 days at most), a random nonce, and a first line `statement` **generated from the fields**, e.g. "Allow 12.7.tape to call these methods of 13.7.tape on my behalf: history. At most 5 calls, valid from … to … UTC. This grant includes no payment. Revocable at any time with 13.7.tape."
2. The visitor's wallet signs it under EIP-712 (its own domain "TapeAPI Visitor Grant", not TAP-11's "TapeAPI" domain). **The visitor checks one thing: the caller named in the first line is the site the wallet says the request comes from.**
3. A adds the top-level member `grant` to every request (the grant, the visitor's signature, and a call proof signed with K over B, the grant hash, the request id and the request hash).
4. B checks in a fixed order, cheap checks first and chain reads last (it is the audience, container and name; the method is granted and marked `grant` in its manifest; the time window; the statement rebuilt character for character; its revocations; the call proof; replay; the visitor's signature, EIP-1271 included; B's own current holder and site status; A's name and holder; no voucher alongside; the count), then writes `result.grant = { hash, caller, user, used, maxCalls }` into its **signed answer**. A treats an answer without that record as a failure (`GRANT_NOT_HONOURED`).
5. Revocation: expiry; or the visitor signs a `GrantRevocation`, delivered to B's free method `grant_revoke`, whose signed answer is the receipt.
6. Every refusal is TAP-13's `BAD_REQUEST` with the reason as the message prefix `grant: <reason>` and **no `error.data`**; new error codes wait for a TAP.

**Boundaries**: every cross-app call is an off-chain request, so the site is no longer "100% on-chain"; revocation and the count are enforced by the called service only and are useless against a malicious one; a receipt proves what B signed, not that the data is right; until shells check it, the visitor compares the site the wallet names with the caller named in the grant; the grant includes no payment (a request with a grant may not carry a voucher); paid calls rely on an escrow that is neither audited nor deployed and cannot be used on mainnet. How wallets display this typed data under a gateway was **not tested**; a local test page and checklist are in [`wallet-render/`](wallet-render/CHECKLIST.zh.md) (empty wallets, no transaction; not run yet).

## 调用序列 / The sequence

```
0. B's holder: the manifest is a file of B's site (on a real chain: api.tx.publishManifest -> SiteRegistry.putFile)
1. A -> chain : discover(api, '13.7.tape')        resolve: read the manifest, check its hash, the holder, the delegation
2. A -> B     : callChecked(api, svc, 'profile')  free, anonymous; A checks the signature twice (api.call, checkReceipt)
3. A          : planGrant(walletApi, svc, { cap, expires })   A makes a one-off session key K and keeps it
   A -> U     : three UNSIGNED transactions: approve(cap), fund(B, cap), authorizeSession(B, K, expires)
   U -> E     : the wallet signs and sends them (here: the escrow model "includes" them)
4. A          : payerFor(api, grant, { user: U })  = api.payer({ consumer: U, sessionKey: K, sessionExpiry })
5. A -> B     : callChecked(api, svc, 'quote', p, { payer })   the request carries a voucher signed by K
   B          : checks the voucher on chain: K's session is live on channel (U, B), unsettled <= channel balance
6. B -> E     : settle (anyone may send it)
7. U -> E     : requestWithdraw, then withdraw 48 h later: U gets back cap - spent
```

复用了什么：TAPI-22 的托管通道与会话钥匙（`api.tx.approve / fund / authorizeSession / requestWithdraw / withdraw`、`api.payer`），服务端的凭证检查（`@tapeapi/server` 原样），SDK 的解析与签名核验。**资金授权没有新写任何格式**（上文实验性的访客授权是另一个、不涉及资金的格式）。上限就是通道余额：B 拒绝超出的凭证，托管合约结算时也不会多付。

What is reused: TAPI-22's escrow channel and session key (`api.tx.approve / fund / authorizeSession / requestWithdraw / withdraw`, `api.payer`), the reference server's voucher checks (`@tapeapi/server` as it ships), the SDK's resolution and signature checks. **The funding grant uses no new format** (the experimental visitor grant above is a separate, non-financial format). The cap is the channel balance: B refuses a voucher above it, and the escrow never pays more at settlement.

**用户有容器时的另一条路（有界代理）：** 用户的容器做委托方，签一份授权书（mandate），A 的代理钥匙经 SDK 的限额器签凭证（客户端在请求之前就拒绝超额）。这条路不用写新代码，`examples/agent-service/agent-service-spend.test.mjs` 的 P1M4-E01（端到端）与 E02（上限）在同样的假链上完整跑过。它要求委托方是**容器**，普通钱包当不了（本目录的测试演示了 `not-tapeout`）。

**When the user holds a container (the bounded agent):** the user's container is the principal and signs a mandate; A's agent key signs vouchers through the SDK's spend limiter (the client refuses an over-cap call before any request). No new code is needed: `examples/agent-service/agent-service-spend.test.mjs` P1M4-E01 (end to end) and E02 (the cap) run it on the same kind of fake chain. It needs the principal to be a **container**; a plain wallet cannot be one (a test here shows `not-tapeout`).

## 证明了什么 / What the tests show

| 现象 / behaviour | 怎么证明 / how (`interop.test.mjs` unless noted) |
|---|---|
| A 按名字找到 B，清单从链上 B 自己的站点读取，委托已核验 / A finds B by name; the manifest is read from B's own site on chain; the delegation is checked | `discovery: ...`：解析时没有请求 B 的端点 / resolving asks B's endpoint nothing |
| 免费调用匿名可行 / a free call works anonymously | `free call: ...`：B 的处理器看到 `consumer: null`，B 收到的东西里没有 A 的地址 / B's handler sees `consumer: null`; nothing B received names A |
| 回执可独立复核 / the receipt can be checked by anyone | `free call`、`receipt: ...`：用 `sig.recoverResponseSigner` 独立恢复签名者；回答改一个字节即 `BAD_SIGNATURE`；换了 params 回执不成立；委托过期后解析报 `DELEGATION_INVALID` / independent recovery; one changed byte is `BAD_SIGNATURE`; other params do not verify; a lapsed delegation is `DELEGATION_INVALID` |
| 没有授权不能付费调用；SDK 不为未列入的托管构造 approve / no grant, no priced call; the SDK builds no approve for an escrow it was not told to allow | `priced call without a grant: ...`：`PAYMENT_REQUIRED`，`escrow-not-allowed` |
| 授权上限内的付费调用成功并有回执 / priced calls within the cap succeed, with receipts | `grant within the cap: ...`：三次成功，每次回执可复核；B 看到的是用户 U 与 A 的钥匙 K / three succeed; B sees user U and key K |
| 超过上限被拒 / above the cap is refused | `the cap: ...`：上限 3.5 个价格，第 4 次被 **B** 拒绝（`BAD_VOUCHER`，不只是 A 自觉），不收费；B 结算恰好 3 个价格；用户 48 小时后取回其余 / the 4th call is refused **by B**, nothing charged; B settles exactly 3 prices; the user takes the rest back after 48 h |
| 到期后被拒 / refused after expiry | `expiry: ...`：A 的 payer 在本地拒绝；不做本地检查的 payer 发出的凭证被 **B** 拒绝 / A's payer refuses locally; B refuses a voucher from a payer that does not check |
| **没有即时撤销** / **there is no instant revoke** | `no instant revoke: ...`：会话不能缩短（`SessionShorteningNotSupported`）；用户唯一的办法是取回请求，B 随即停止服务，但钥匙在链上仍然有效；取消请求后 A 立即恢复 / a session cannot be shortened; a withdraw request stops B while the key stays authorised; cancelling restores A at once |
| B 看不出调用方是 A（缺口）/ B cannot tell the caller is A (a gap) | `free call`、`grant within the cap`：B 只知道"哪个用户付钱、哪把钥匙签名" / B only knows which user paid and which key signed |
| 访客授权（实验性）/ the visitor grant (experimental) | 两个 `visitor grant` 测试：B 核对后在签名回答里写出 A 与授权记录；回执覆盖记录；伪造、方法越界（含带凭证的收费方法）、过期一律 `BAD_REQUEST`（`grant: <原因>`，无 `error.data`），处理器不运行、不收费。逐项正反向测试在 `interop-grant.test.mjs`（16 项：计数与用尽、required、越权方法、时间窗、有效期上限、调用证明与钥匙、受众与 B 易手、重放与读链失败后重试、与凭证并存、撤销两档、A 的名字与易手、名字的 TAP-10 站点状态（未开通、未激活）、statement、EIP-1271、回写记录、不经我方主机）/ B names A and writes the grant record in its signed answer; refusals are `BAD_REQUEST` with `grant: <reason>`, no `error.data`, handler not run, nothing charged; each rule both ways in `interop-grant.test.mjs` (16 tests) |
| 普通钱包当不了授权书的委托方 / a plain wallet cannot be a mandate's principal | `what is not there: ...`：`not-tapeout`；容器的阶段 0 授权书能验过但 `enforcement: none` |
| 不联网 / offline | `offline: ...`：所有请求都落在假链节点或 B 的进程内端点；`demo.mjs` 跑完全程 / every request went to the fake chain or B's in-process endpoint |
| A 的代码能在浏览器里跑（静态检查）/ A's code is browser-plain (static check) | `browser-graph.test.mjs`：A 与 B 的处理器只导入 `@tapeapi/sdk` 与 `@tapeapi/interop`，没有 `node:`、`Buffer`、`process`；SDK 主入口的导入图用调试台构建的同一检查遍历，`@tapeapi/interop` 的导入图由 `interop/test/interop.test.mjs` 遍历 / imports only the SDK and `@tapeapi/interop`; both graphs are walked |

## 没有证明什么 / What this does not show

- **回执只证明"B 的委托签名钥匙在这个时刻对这个请求签了这个回答"**，不证明回答是对的，也不证明 B 背后的上游（数据源、模型）是什么。
- **托管合约未审计、未部署**，SDK 的 `AUDITED_ESCROWS` 是空的；这里的托管是模型（合约本身另有 forge 测试）。**主网上今天不能用**，只在本地链与测试里验证过。
- 解析走的是假链上的 1.x 路径（自定义 hub 等地址），**不覆盖 2.0 的默认 TAP-10 一致模式**（`conform: 'tap10'`，钉块、激活检查）；`world.mjs` 的客户端写明 `dev: true`（2.0 起即 1.x 解析，未弃用），因为默认模式在创建时拒绝假链自己的地址。B 核验访客授权时读名字与持有人（`chainReadsFromApi`）与 2.0 默认解析一致：经 SDK 的 TAP-10 站点状态（`siteStatus`，钉块，检查开通与激活）读取，所以 2.0 默认客户端会拒绝的名字，授权核验同样拒绝（`grant: caller-not-opened`、`grant: caller-unpaid`；B 自己未开通或未激活时为 `audience-not-opened`、`audience-unpaid`）。假链前面加了一层激活合约读取（两个应用默认已激活），测试可以改动它。
- 没有在真实浏览器、外壳或网关里跑过；浏览器检查是静态的。没有测量 gas 或费用。
- 用户钱包"签名并发送"是模拟的：托管模型按交易自己的 calldata 执行，不签名、不广播。

- **A receipt only proves "B's delegated signer key signed this answer to this request at this time"**: not that the answer is right, nor what upstream (data source, model) is behind B.
- **The escrow is neither audited nor deployed**, and the SDK's `AUDITED_ESCROWS` is empty; the escrow here is a model (the contract has its own forge tests). **It cannot be used on mainnet today**; this was checked on local chains and in tests only.
- Resolution takes the 1.x path on the fake chain (custom hub and other addresses); it **does not exercise the 2.0 default, the TAP-10 conformance mode** (`conform: 'tap10'`: block pinning, activation checks); the clients in `world.mjs` say `dev: true` (since 2.0 the 1.x resolution, not deprecated), because the default refuses the fake chain's own addresses when a client is made. B's grant check reads names and holders (`chainReadsFromApi`) as the 2.0 default resolution does: through the SDK's TAP-10 site status (`siteStatus`: a pinned block, opening and activation checked), so a name a 2.0 default client refuses is refused by the grant check too (`grant: caller-not-opened`, `grant: caller-unpaid`; `audience-not-opened`, `audience-unpaid` when B itself is not opened or not activated). The fake chain gets an activation-contract layer in front of it (both apps activated by default), which the tests change.
- Nothing ran in a real browser, shell or gateway; the browser check is static. No gas or fee was measured.
- The user's wallet "signing and sending" is simulated: the escrow model applies each transaction from its own calldata; nothing is signed or broadcast.

## 缺什么 / What is missing

1. **调用方身份（不带授权时）。** 请求里只有 `id / method / params / voucher`，没有"哪个应用"。B 在免费调用里什么都不知道，在付费调用里只知道用户和钥匙。浏览器发出的请求带 `Origin` 头，但它不在签名覆盖范围内、非浏览器客户端可以随意填写，**不能当身份**。
2. **访客授权只是实验性原型**（上一节）：B 能确认的是"用户在钱包里同意了钥匙 K 代表名字 A，且这次请求确由 K 签"，**不是**"调用方就是 A"（外壳把关之前，钓鱼站可以诱导用户签一份以 A 为名的授权，后果以授权书里的方法、次数与期限为限）。撤销只约束收到撤销的那一个 B；计数只由 B 执行。参考存储（`memoryGrantStore`）只在内存里、只适合单进程：**撤销、计数与重放记录在进程重启后全部丢失**（包括 A 易手后的“永久”撤销），生产服务须持久化；撤销条数有上限（默认 10 万），授权过期后自动清理，存满时拒绝新的撤销而不丢弃旧的。**交付后回答丢失**：B 交付时已计次并记下 (授权, id)，并保留这份已签回答；回答若在网络上丢失，SDK 的稳定 `call` 会用同一个 id 换端点重试，B **原样重发首次签好的回答**（逐字节相同，不重签、不再计次）。保留期至多为回答 ts 之后 300 秒，参考存储默认最多 1 000 份；超期、被挤掉、或重试的参数不同时，照旧答 `grant: replayed`（调用方看到失败，一次额度已用掉）。读链与 2.0 默认解析一致（钉块、检查开通与激活），缓存不超过 60 秒；按（调用方, 访客）的限流窗口在 SDK 存储里，可选、默认关（`perGrantWindow`，超出答 `grant: rate-limited`）；IP 免费额度退还与坏授权计入 `fail:ip` 在服务端限流器里，没有做。钱包怎么显示它没有实测；任何新的"请签名"都是新的钓鱼面。
3. **授权只能按服务，不能按方法。** 通道是 (用户, B) 一条：A 的钥匙可以花在 B 的任何收费方法上。授权书的 scope 也只能写服务方（`Scope(provider, token, cap)`）。
4. **没有即时撤销。** 会话钥匙只能延长、不能缩短，最长 30 天后自然过期；用户能做的只有取回请求（48 小时冷静期，期间参考服务端停止服务该通道，但已签的凭证仍可结算），资金损失上限是通道余额。
5. **普通钱包当不了授权书的委托方**（要求容器）；钱包用户只能直接用会话钥匙，客户端的限额器（请求前拒绝超额）只在授权书那条路上有。
6. **一个用户、一个服务方只有一条通道。** 用户同时授权 A 和 C 调用 B，两个应用共用一份余额和一个累计计数，余额不是按应用分的。
7. **A 的会话钥匙存在 A 的源里**（浏览器存储）：A 的任何新发布都能读到它。
8. **非资金权限**（"A 可以读我在 B 的资料"）今天没有任何 TAP；本示例用实验性的访客授权演示了一种做法（上文），它不是规范。
9. **B 必须有签名端点。** 见下一节。

1. **Caller identity (without a grant).** A request carries `id / method / params / voucher` and nothing names the calling app. On a free call B knows nothing; on a priced call it knows the user and the key. A browser's request carries an `Origin` header, but no signature covers it and a non-browser client can write anything there: **it is not an identity**.
2. **The visitor grant is an experimental prototype** (previous section): what B can confirm is "the user agreed in the wallet that key K speaks for name A, and K signed this request", **not** "the caller is A" (until shells check it, a phishing site can lure a user into signing a grant in A's name, bounded by the grant's methods, count and validity). A revocation binds only the B that received it; only B counts. The reference store (`memoryGrantStore`) is in memory and fits one process only: **revocations, counts and replay records are lost when the process restarts** (the "for good" revocation after A changes hands included), so a production service persists them; revocations are bounded (100 000 by default), dropped once their grant has expired, and a full store refuses a new revocation rather than dropping an old one. **An answer lost after delivery**: B counts the call, records (grant, id) and keeps the signed answer when it delivers; if the answer is lost on the network, the SDK's stable `call` retries the same id on the next endpoint and B **sends the first signed answer again**, byte for byte (not signed or counted again). It is kept for at most 300 s after its ts, 1 000 answers by default in the reference store; past that, pushed out, or for a retry with other params, B answers `grant: replayed` as before (the caller sees a failure while one call of the grant is used). Chain reads follow the 2.0 default resolution (a pinned block, opening and activation checked), cached at most 60 s; a rate-limit window per (caller, visitor) is in the SDK's store, optional and off by default (`perGrantWindow`, one more call is refused `grant: rate-limited`); refunding the IP's free budget and counting bad grants in `fail:ip` live in the server's limiter and are not done. How wallets display it was not tested; every new "please sign" is a new phishing surface.
3. **Grants are per service, not per method.** There is one channel (user, B): A's key can spend on any priced method of B. A mandate's scope also names only providers (`Scope(provider, token, cap)`).
4. **No instant revoke.** A session key can be extended, never shortened, and lapses by itself after at most 30 days; the user's only lever is a withdraw request (48 h cooldown; meanwhile the reference server stops serving the channel, but vouchers already signed can still settle). The most the user can lose is the channel balance.
5. **A plain wallet cannot be a mandate's principal** (a container is required); a wallet user uses the session key directly, and the client-side spend limiter (refusing an over-cap call before any request) exists only on the mandate path.
6. **One channel per user and provider.** If the user lets both A and C call B, the two apps share one balance and one cumulative count; the balance is not per app.
7. **A's session key lives in A's origin** (browser storage): any new release of A can read it.
8. **Non-financial permissions** ("A may read my profile at B") have no TAP today; this example shows one way with the experimental visitor grant (above), which is not a specification.
9. **B needs a signing endpoint.** See the next section.

## B 是静态站点时 / When B is a static site

DeWEB 站点是纯前端：每个回答都要用清单里 `signer` 的私钥签名，这把钥匙必须放在一个运行着的进程里，静态站点自己做不到。B 要成为服务方，需要一个持签名钥匙的端点，例如一个 Cloudflare Worker 或一个旁路进程；清单仍是 B 站点里的文件，名字、容器、持有人不变。现成的模板：`examples/cloudflare-worker/`（通用 Worker，配合持有人操作台上线）、`examples/public-api/worker.js`（生产用的 Worker）、`examples/mcp-proxy/`（已有 MCP 服务器时放在前面签名）。本示例的处理器只导入 SDK，可以原样放进 Worker：

A DeWEB site is front-end only: every answer must be signed with the private key of the manifest's `signer`, which has to live in a running process; a static site cannot do that. To be a provider, B needs an endpoint that holds its signer key, such as a Cloudflare Worker or a sidecar process; the manifest stays a file of B's site, with the same name, container and holder. Ready templates: `examples/cloudflare-worker/` (a general Worker, brought online with the holder console), `examples/public-api/worker.js` (a production Worker), `examples/mcp-proxy/` (signing in front of an existing MCP server). This example's handlers import only the SDK and can go into a Worker as they are:

```js
import { createProvider } from '@tapeapi/server'
import { createAppB } from './app-b.mjs'
const provider = createProvider({ manifest, signerKey: env.SIGNER_KEY, methods: createAppB().methods, rpcUrls })
export default { fetch: (request) => provider.handleRequest(request) }
```

（示意，未部署；上线还需要激活的名字、持有人签的委托、一个 HTTPS 主机名。/ A sketch, not deployed; going live also needs an activated name, the holder's delegation and an HTTPS host name.）

## 与 TAP-10 来源隔离的关系 / TAP-10 origin isolation

TAP-10（已合并为 Draft，合并不等于被采纳）规定一个站点一个来源、存储按来源隔离、钱包权限按来源记录（§8.1、§8.3、§8.4）。这种隔离是刻意的，本示例不绕开它：A 和 B **从不共享存储**，A 读不到 B 的任何东西，B 也读不到 A 的。互通只走三条路：**链**（A 从链上读 B 的清单，用户在链上开通道）、**签名调用**（A 向 B 的端点发请求，B 签名，A 自己核验）、**消息**（本示例没有用到）。A 对 B 端点的请求是链下请求：按 TAP-10 §8.5，外壳可以放行也可以拦截，放行时要记录并在 §9 的标识里体现，所以这样的 A 不会显示"100% on-chain"。TAP-11、TAP-13（服务清单与签名回答，已合并为 Draft，合并不等于被采纳）本示例原样使用，没有改动。

TAP-10 (merged as a Draft; a merge is not adoption) gives each site its own origin, isolates storage per origin and records wallet permissions per origin (§8.1, §8.3, §8.4). The isolation is deliberate and this example does not work around it: A and B **never share storage**; A cannot read anything of B's, nor B of A's. Interop goes only through **the chain** (A reads B's manifest from the chain; the user opens a channel on chain), **signed calls** (A sends a request to B's endpoint, B signs, A checks), and **messages** (not used here). A's request to B's endpoint is an off-chain request: under TAP-10 §8.5 a shell may allow or block it, and when it allows it, it records it and reflects it in the §9 indication, so such an A does not show "100% on-chain". TAP-11 and TAP-13 (the service manifest and signed answers, merged as Drafts; a merge is not adoption) are used here as they are, unchanged.

## 文件 / Files

| 文件 / file | 作用 / what it is |
|---|---|
| `app-a.mjs` | 调用方 A：`discover`、`checkReceipt`、`callChecked`、`planGrant`、`payerFor`、`askVisitorGrant`、`signedGrant`、`revocationRequest`（浏览器安全）/ the caller (browser-safe) |
| `app-b.mjs` | 被调用方 B 的处理器与 `seen`（B 对每次调用能知道什么）/ B's handlers and what B can know about each call |
| `world.mjs` | 假链世界：A、B、用户钱包、托管模型、一个记录所有请求的 `fetch` / the fake-chain world |
| `demo.mjs` | 打印整个过程 / the whole story, printed |
| `interop.test.mjs`, `interop-grant.test.mjs`, `browser-graph.test.mjs` | 测试 / the tests |
