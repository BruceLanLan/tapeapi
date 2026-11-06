# 容器与容器的互通示例 / Container-to-container interop example (experimental)

**实验性。** 用**现有 API** 演示容器与容器之间三种互通：(a) 代理在授权书的上限内调用另一个容器的付费方法；(b) 任务消息线程：交付与验收；(c) 私密通道里的加密消息，以及对请求的签名回执。全部在 SDK 的**假链**上、同一个进程里跑：不联网、不花钱、不碰真实钱包，密钥都是测试夹具。基于 `@tapeapi/sdk/agent` 与 `@tapeapi/sdk` 的通道模块；`agent` 子路径整体不受兼容承诺约束，格式可能随公开讨论（TapeOutProtocol/TAPs 的 #47 草稿、#41、#12）改变。示例不在 npm 包里。

**Experimental.** It demonstrates three kinds of container-to-container interop with the **existing API**: (a) an agent calls another container's paid method inside the limit a mandate sets; (b) a task message thread, with delivery and acceptance; (c) encrypted messages in a private channel, and a signed receipt for a request. Everything runs on the SDK's **fake chain**, inside one process: no network, no cost, no real wallet, and every key is a test fixture. It builds on `@tapeapi/sdk/agent` and the channel module of `@tapeapi/sdk`; the `agent` subpath is outside the compatibility promise as a whole, and its formats may change with the public discussions (the draft in TapeOutProtocol/TAPs #47, #41 and #12). The example is not in the npm package.

应用与服务之间的访客授权（VisitorGrant）是另一条线，不在这里。这里只有容器对容器。
Visitor authorisation between an application and a service is a separate line of work and is not here. This is containers only.

## 先读这几句 / Read this first

- **回执只证明"这个容器在这个时间对这个请求签了这个回答"。** 不证明回答是对的，不证明活儿做对了，也不证明容器背后用的是哪个模型或哪份代码。(b) 里有一个现成的反例：B 的交付签名有效、线程核验全绿，数字却不是上游签过的那个，只有 A 自己的核对能发现。
- **(a) 的托管合约没有经过审计，也没有部署，主网不可用。** (a) 只在本地链模型与测试里验证（模型执行的就是合约的状态变化，合约的 Foundry 测试执行同样的交易）。(b)(c) 不涉及托管合约，但同样只在假链上验证过。
- **授权书里的限额，约束的是"遵守它的代理运行时"和"那一条通道"，不是 B。** B 看到的是会话钥匙签的有效凭证，并不知道授权书的存在。
- **解析走假链上的 1.x 路径，不覆盖 2.0 的默认一致模式**（`conform: 'tap10'`：钉块、激活检查）。假链的 hub、factory 是自己的地址，2.0 默认客户端在创建时就拒绝它们；本目录新建的客户端写明 `dev: true`，A 的客户端来自 agent-service 演示世界（测试辅助传 `conform: false`，2.x 内已弃用、仍保留）。
- **A 的人（持有人）在钱包里签。** 示例用假链夹具密钥代签；有资金的授权书只经测试辅助的 `mandateMsg` 签，本目录的源码从不自己绕过 SDK 的阶段 0 闸门（测试扫描源码确认）。

- **A receipt proves "this container signed this answer to this request at this time", and nothing more.** Not that the answer is right, not that the work is right, not which model or code is behind the container. (b) has a ready counter-example: B's delivery is validly signed and the thread check is green, yet a number in it is not the one the upstream signed; only A's own check finds it.
- **The escrow contract behind (a) is unaudited and not deployed: it is not available on mainnet.** (a) is verified on a local chain model and in tests only (the model runs the contract's state changes, and the contract's Foundry tests run the same transactions). (b) and (c) use no escrow contract, but are likewise verified on the fake chain only.
- **A limit in a mandate binds "an agent runtime that honours it" and "that one channel", not B.** B sees a valid voucher signed by a session key; it does not know the mandate exists.
- **Resolution takes the 1.x path on the fake chain; the 2.0 default, the conformance mode (`conform: 'tap10'`: block pinning, activation checks), is not exercised.** The fake chain's hub and factory are its own addresses, which a 2.0 default client refuses when it is made; the client this directory makes says `dev: true`, and A's clients come from the agent-service demo world (the test helper passes `conform: false`, deprecated in 2.x and kept).
- **A's human (the holder) signs in a wallet.** The example signs with the fake chain's fixture keys; a funded mandate is signed only through the test helper `mandateMsg`, and the source in this directory never opts out of the SDK's phase-0 gate itself (a test scans the source).

## 谁是谁 / Who is who

| 场景 / scenario | A | B | 其它 / others |
|---|---|---|---|
| (a) 付费调用 / paid calls | #11，委托方容器，其持有人签授权书 / principal container, its holder signs the mandate | #13，收费服务容器 / the priced service container | A' = #12，A 的代理容器（带限额器的运行时）/ A's agent container (runtime with the spend limiter) |
| (b) 任务线程 / task thread | #11，委托方，持有人签报价、授权书、裁决 / principal; its holder signs offer, mandate and verdict | #12，代理容器，清单 signer 签接单与交付 / the agent container; its manifest signer signs accept and delivery | S = #13，B 为任务读取的上游 / the upstream B reads for the task |
| (c) 私密通道 / private channel | #11 | #16，一个免费方法 `quote` / one free method, `quote` | #15，中继：只存密文 / the relay: stores ciphertext only |

## 运行 / Run

在仓库根目录（先 `npm install --no-audit --no-fund` 一次），Node 22+。
From the repository root (`npm install --no-audit --no-fund` once), Node 22+.

```bash
node examples/container-interop/run.mjs spend                 # (a) A's agent calls B's paid method inside a cap
node examples/container-interop/run.mjs spend --cap 2 --calls 4   # more calls than the cap: the extra ones are refused
node examples/container-interop/run.mjs thread                # (b) the task thread, accepted
node examples/container-interop/run.mjs thread --lie          # (b) B misreports what S answered: A rejects
node examples/container-interop/run.mjs channel               # (c) the private channel and B's signed receipt
node examples/container-interop/run.mjs all
node --test examples/container-interop/*.test.mjs             # the tests: 9 + 7 + 7 for the scenarios, 6 for the entry and the scans
```

退出码：0 场景按设计结束，1 没有，2 用法错误。/ Exit status: 0 the scenario ended as designed, 1 it did not, 2 a usage mistake.

## (a) 代理在授权书的上限内调用 B 的付费方法 / The agent calls B's paid method inside a cap

文件 / file: `spend-call.mjs`，测试 / tests: `spend-call.test.mjs`。

A 的持有人签一份授权书：scope 只有 B，`cap` 是 10 次调用的价钱；持有人只给 A → B 这**一条**通道注资，并把代理为这一单新生成的 `agentKey` 授权为这条通道上的会话钥匙。代理运行时（`examples/agent-service/agent.mjs` 的限额器）每次调用前重新核验授权书与通道，只经限额器用该钥匙签凭证：累计不会超过开工时已领取额加 `cap`，单次价格不会超过上限（默认 cap 的 10%）。

A's holder signs a mandate whose scope is B alone and whose `cap` is the price of ten calls; the holder funds that **one** channel (A → B) and authorises the `agentKey` the agent made for this order as a session key on it. The agent runtime (the limiter of `examples/agent-service/agent.mjs`) re-checks the mandate and the channel before every call and signs vouchers with that key only through the limiter: the cumulative amount cannot exceed what was already claimed at the start plus `cap`, and no single price may exceed the ceiling (10% of the cap by default).

`node examples/container-interop/run.mjs spend` 的输出 / the output:

```text
 1. [A -> A'] offer (signed by A's holder); A' accepts with a fresh agentKey
 2. [A] mandate signed: scope = [B], cap 100000 (10 calls at 10000), expires …
 3. [A (wallet)] funding plan applied: approve, fund, authorizeSession
 4. [A'] verified the mandate against the chain: enforcement escrow-channel; work starts
 5. [A' -> B] call 1: blockNumber, one voucher of 10000 (answered: 62000000)
 6. [A' -> B] call 2: blockNumber, one voucher of 10000 (answered: 62000001)
 7. [A' -> B] call 3: blockNumber, one voucher of 10000 (answered: 62000002)
 8. [B] settles the vouchers it holds on the escrow: settle
 9. [A' -> A] delivery: 3 hash-only receipt(s) of B's answers; spend statement: claimed 0 -> 30000, spent 30000
10. [A] thread check: state Delivered, ok true, enforcement escrow-channel; 0x5e5E5e…: equal, paid now 30000 for 3 receipted call(s)
11. [A] receipts: 3/3 signed by B's published signer for method blockNumber with params {}
    A closed the channel out (requestWithdraw, withdraw): 70000 returned of 100000 funded
```

回执核验有两层，都在这个脚本里 / The receipts are checked in two ways, both in this script:

- `kit.verifyTaskThread(thread, { enforcement: 'escrow-channel' })`：线程里谁签了什么，以及交付里的花费说明与链上读数、"回执张数 × 清单单价"对账（`reconciled: 'equal'`）。/ who signed what, and the delivery's spend statement reconciled with the chain and with "receipts × the manifest's price".
- `receipts.mjs` 的 `verifyReceipt`：逐张回执，从回执里的签名恢复签名者，必须等于 B **此刻**清单发布的 signer；请求哈希必须等于 `{ method: 'blockNumber', params: {} }` 的哈希。/ `verifyReceipt` in `receipts.mjs`: each receipt's signature is recovered, and the signer must be the one B's manifest publishes **now**; the request hash must be that of `{ method: 'blockNumber', params: {} }`.

**证明了什么 / What it shows** (tests: `a: …`)

- 5 次调用、cap 为 3 个价格：第 4、5 次在发出任何请求之前就被拒绝（`spend-cap-exceeded`），B 只回答了 3 次；代理签出的凭证累计恰为 3 个价格。/ five calls under a cap of three prices: the fourth and fifth are refused before any request (`spend-cap-exceeded`), B answered three, and the vouchers the key signed total exactly three prices.
- 任务要求调用 scope 之外的容器：`out-of-scope`，那个容器从未被联系。/ a task asking for a container outside the scope: `out-of-scope`, and that container was never contacted.
- 授权书被撤销（站点撤销清单）：之后的调用被拒绝（`mandate-revoked`），交付也被拒绝；B 只见过撤销之前的 1 次调用。/ a revoked mandate (the site list): later calls are refused (`mandate-revoked`), and so is the delivery; B saw only the one call before the revocation.
- 价格高于单次上限：在发出请求前就拒绝，订单不会被停掉。/ a price above the per-call ceiling is refused before any request and does not stop the order.
- 收尾取回：持有人拿回 cap 减已花的部分，付出的恰好是代理花的。/ the close-out: the holder gets back cap minus spent and has paid exactly what the agent spent.

**没有证明什么 / What it does not show**

- 不证明 B 回答得对，也不证明代理该不该调用（回执只证明"B 回答并签了名"）。/ That B's answers are right, or that the calls were needed.
- 不约束 B：B 不知道授权书；它按凭证收款。泄露的会话钥匙能把**那一条通道**花光，不能碰别的通道（现有测试 `P1M4-E03`）。会话钥匙不能撤销，只能等它过期。/ It does not bind B: B does not know the mandate and charges by voucher. A leaked session key can drain **that one channel** and no other (the existing test `P1M4-E03`). A session key cannot be revoked, only outlived.
- 线程核验是**此刻**的检查：花光 cap 并结算后，或 A 收尾取回之后，它报 `channel-empty` / `session-missing`，线程停在 `Accepted`（测试 `a: a cap spent in full…` 与 `a: after close-out…`）。回执本身仍然可以核验。见"缺口"。/ The thread check is a **point-in-time** check: once the cap is spent in full and settled, or after A has closed out, it says `channel-empty` / `session-missing` and the thread stays `Accepted` (tests `a: a cap spent in full…` and `a: after close-out…`). The receipts themselves still verify. See "Gaps".
- 托管合约没有审计、没有部署；主网不可用。/ The escrow contract is unaudited and not deployed; not available on mainnet.

## (b) 任务线程：B 交付，A 验收 / A task thread: B delivers, A accepts

文件 / file: `task-thread.mjs`，测试 / tests: `task-thread.test.mjs`。

线程就是 `examples/agent-service` 的那一套（`tape.agent/offer`、`accept`、`mandate`、`deliver`、`acceptance`、`revocation`，TAP-18，即 TapeOutProtocol/TAPs#47，已合并为 Draft，合并不等于被采纳），阶段 0：授权书只是持有人的受托声明，`enforcement: none`，cap 必须为 0。本文件补的是 **A 一侧的验收**：线程核验证明谁签了什么、各部分是否属于同一个线程，不看交付物的内部；所以 A 在签裁决之前自己核对——交付物要哈希到 B 签过的值，里面的每个数都必须是 S 签过的某张回执的回答体。

The thread is the one of `examples/agent-service` (`tape.agent/offer`, `accept`, `mandate`, `deliver`, `acceptance`, `revocation`; TAP-18, from TapeOutProtocol/TAPs #47, merged as Draft; merging is not adoption), phase 0: the mandate is only the holder's declaration of what was entrusted, `enforcement: none`, caps must be 0. What this file adds is **A's side of the acceptance**: the thread check proves who signed what and that the pieces belong together, and does not look inside the deliverable; so before it signs a verdict A checks for itself that the deliverable hashes to what B signed and that every number in it is the body of a receipt S signed.

```text
1. A -> B offer 0xe32c5b88…; B accepts, agentKey 0x… (made for this order)
2. A -> B mandate 0x…, scope 1 container(s); B verified it and started: working
3. B -> A delivery: 1 receipt(s) of S's answers; deliverable {"kind":"chain.block-height",…,"answers":[{"provider":"0x5e5E…","blockNumber":62000000}]}
4. thread: state Delivered  ok true  enforcement none  selfHire false
   evidence: 1 receipt(s), ok true; proves: each listed call was answered and signed by …; does NOT prove: that the calls were needed; that the answers were right; that the deliverable is correct or complete
   A's own check of the deliverable: ok
5. A -> B verdict: accepted (verdictHash 0x…); thread state Settled
```

用 `--lie` 时 B 报告的每个数都比 S 答的大 1：线程核验仍是 `Delivered`、`ok true`（B 的签名有效、回执真是 S 签的），A 自己的核对报 `answer-not-in-receipts`，A 签 `rejected`，线程停在 `Rejected`；B 签过的交付仍然留在记录里，是 B 自己的陈述。
With `--lie`, every number B reports is one above what S answered: the thread check still says `Delivered`, `ok true` (B's signature is valid and S really signed the receipt), A's own check says `answer-not-in-receipts`, A signs `rejected`, and the thread stays `Rejected`; B's signed delivery remains on record as B's own statement.

**证明了什么 / What it shows**

- 报价只被点名的容器接受（报价写别的代理容器会被拒，B 不保留订单、不公布钥匙）。/ Only the named container accepts an offer (an offer for another agent container is refused; B keeps no order and announces no key).
- 任务文本被改动的线程核验失败（`task-hash-mismatch`）。/ A thread whose task text was edited does not verify (`task-hash-mismatch`).
- 撤销之后 B 不再签交付（`mandate-revoked`）。/ After a revocation B signs no delivery (`mandate-revoked`).
- 自雇自会被标出，不会被隐藏或拒绝（`selfHire`，原因 `same-holder`）。/ A self-hire is flagged, never hidden or refused (`selfHire`, reason `same-holder`).

**没有证明什么 / What it does not show**

- 没有仲裁：A 可以拒收或沉默，B 只能保留证据。/ There is no arbiter: A may reject or stay silent, and B can only keep its evidence.
- 回执的哈希只能藏住猜不到的内容；取自小集合的参数或很短的回答，可以用候选值求哈希来确认。/ A hash hides only what cannot be guessed: parameters from a small set, or a short answer, can be confirmed by hashing candidates.
- 这个示例里 A 的核对只对 `chain.block-height` 这一种交付物成立；别的任务要写自己的核对。/ A's check here is written for the one kind of deliverable, `chain.block-height`; another task needs its own check.

## (c) 私密通道里的加密消息与签名回执 / Encrypted messages in a private channel, and a signed receipt

文件 / file: `private-exchange.mjs`，测试 / tests: `private-exchange.test.mjs`。

1. 双方从链上读对方的通道公钥（`api.chain.channelKeys`：只认电路**当前**持有人授权的记录；电路换手，旧记录失效）。/ Each side reads the other's channel keys from the chain (`api.chain.channelKeys`: only records authorised by the circuit's **current** holder; a sold circuit's record stops working).
2. A 把密封邀请投进 B 的收件房间；B 打开、应答；A 完成、确认（三次 Diffie-Hellman：相互验证身份、前向保密）。两边都显式传 `labels: 'v2'`（TAPI-26 v2，标签 `tape-channel/…`，2.0 起为 Stable (v2) 且是默认）。/ A posts a sealed invite to B's inbox room; B opens it and accepts; A completes and confirms (three Diffie-Hellmans: mutual authentication, forward secrecy). Both sides pass `labels: 'v2'` explicitly (TAPI-26 v2, labels `tape-channel/…`, Stable (v2) and the default since 2.0).
3. A 在通道里发请求 `{ t: 'call', id, method, params }`；B 把它当**数据**，交给自己的 provider，就像收到一个 HTTPS 请求；provider 签的 TAPI-21 信封（B 的清单 signer、请求的 id、方法与参数、回答体、时间）经通道回给 A。/ A sends `{ t: 'call', id, method, params }` in the channel; B treats it as **data** and hands it to its own provider as the HTTPS request it would have received; the TAPI-21 envelope that provider signs (B's manifest signer, the request's id, method and params, the body, the time) comes back through the channel.
4. A 用 B 当前发布的 signer 核验，并保存回执；可以原样、也可以用 `mcp.hashReceipt` 的只含哈希形式出示给第三方。/ A checks it against B's published signer and keeps the receipt, in full or in the hash-only form of `mcp.hashReceipt`, to show to a third party.

```text
1. A read B's channel keys from the chain (holder 0x…); x25519 0x…
2. A posted a sealed invite (453 bytes) to B's inbox room e4e84a4cb1…
3. B opened the invite, read A's keys from the chain (holder 0x…), and posted its accept
4. handshake complete: channel 223faf3567… (labels v2), confirmed on both sides
5. A -> B (in the channel): {"t":"call","id":"c-…","method":"quote","params":{"sku":"widget-7","qty":12}}
6. B -> A (in the channel): ok true, signed by container 0xB7B7…
7. A checked the envelope against B's published signer: ok, signer 0x…
   the relay holds 5 wire message(s); the request text appears in none: true
```

**证明了什么 / What it shows**

- 中继只存了 5 条线路消息（密封邀请、accept、ready、请求、回答），搜不到请求或回答里的任何文字。/ The relay stored five wire messages (sealed invite, accept, ready, request, answer), and none shows any text of the request or the answer.
- 两个版本不互通且失败关闭：A 用 v2、B 用 v1（反过来也一样）得不到通道，SDK 报 `CHANNEL_INVALID` 与 `data.labels` / `data.peerLabels`。/ The two versions do not interoperate and fail closed: A on v2 and B on v1 (or the other way round) get no channel, and the SDK says `CHANNEL_INVALID` with `data.labels` / `data.peerLabels`.
- 重放的帧、被改过一位的帧、别的通道的帧、乱序的帧都被拒绝；B 的电路换手后，A 不会向它的旧密钥投递邀请。/ A replayed frame, a frame with one bit changed, a frame of another channel and a frame out of order are refused; after B's circuit changes hands A posts no invite to its old key.
- 回执的各种伪造都核验不过：陌生密钥签的、把 B 对另一个请求的回答搬过来的、改了回答体的、改了 id 的。/ Receipts made in the ways an attacker would try do not verify: signed by a stranger's key, B's answer to another request moved over, an edited body, an edited id.
- B 不认识的方法，B 的 provider 签一份 `METHOD_NOT_FOUND`；这份签名的拒绝同样是 B 的回答，同样核验得过。/ For a method B does not serve, B's provider signs `METHOD_NOT_FOUND`; that signed refusal is also an answer of B's and verifies the same way.

**没有证明什么 / What it does not show**

- 回执说"B 回答了这个"，不说"B 核对过 A 有权问"：B 在这里看不到授权书或授权。/ The receipt says "B answered this", not "B checked that A was entitled to ask": B sees no mandate or grant here.
- **A 没有签请求。** 通道的相互验证身份是对称的（双方共用密钥），第三方无法据此判断某一帧出自哪一方，所以 B 无法向第三方出示"A 问过这个"。回执也不含通道号：同一个回答在哪条通道里来，回执不说。/ **A signed nothing over the request.** The channel's mutual authentication is symmetric (the two sides share the keys), so it cannot show a third party which side wrote a frame, and B cannot show anyone that A asked this; and the receipt carries no channel id, so it does not say which channel an answer came through.
- 请求/回答的成帧（`{ t: 'call' | 'answer' }`）是本示例自己的，不是规范；通道也不承载 `tape.agent/*` 线程（#47 只规定了经 TAP-13 调用的承载）。/ The request/answer framing is this example's own and not a specification; nor does the channel carry the `tape.agent/*` thread (#47 specifies only the carriage by TAP-13 calls).
- 中继看得到房间名、帧大小与时间，以及谁在轮询（IP）；收件房间由容器地址推导，所以任何人都能算出某个容器的收件房间。/ The relay sees room names, frame sizes and timing, and who polls (the IP); an inbox room is derived from a container address, so anyone can compute a container's inbox room.

## 与 TAP-10 来源隔离的关系 / How this relates to TAP-10's origin isolation

TAP-10 §8 约束的是**壳**如何运行站点代码：每个站点一个独立来源（§8.1），存储按来源隔离（§8.3），钱包只给真正独立的来源（§8.4），站点的链下请求归壳记录与指示（§8.5、§9）。本示例里的三个场景都是**服务端之间**的调用，跑在 Node 里，不经过任何壳，也不在任何站点的来源里：

- 它不削弱、也不绕过 §8：没有跨来源存储、没有 `postMessage` 桥、没有向站点注入钱包；A 的持有人签名发生在持有人自己的钱包里（示例里由夹具密钥代签）。
- 它不替壳做决定：如果同样的调用是由某个站点的**页面代码**发起的（浏览器里的应用调用 B），那就是 §8.5 的链下请求：壳可以允许或阻止，但必须记录，并在 §9 的指示里反映出来。这条路上的授权（应用代表访客调用服务）是另一条线，不在本示例里。
- 所有身份都从链上推导（TAP-10 §4）：容器、持有人、签名者、通道密钥都经 `api.resolve` / `api.chain.channelKeys` 读链得出，没有一处相信请求或消息的自述。

TAP-10 §8 constrains how a **shell** runs site code: one independent origin per site (§8.1), storage isolated by origin (§8.3), wallets only for real independent origins (§8.4), and a site's off-chain requests recorded and indicated by the shell (§8.5, §9). All three scenarios here are calls **between server-side runtimes**, in Node, passing through no shell and running in no site's origin:

- It does not weaken or bypass §8: there is no cross-origin storage, no `postMessage` bridge, no wallet injected into a site; A's holder signs in the holder's own wallet (here the fixture keys stand in).
- It does not decide for the shell: if the same calls were made by a site's **page code** (an application in a browser calling B), they would be §8.5 off-chain requests: the shell may allow or block them, but must record them and reflect them in the §9 indication. Authorisation on that path (an application calling a service on a visitor's behalf) is a separate line of work and is not in this example.
- Every identity is derived from the chain (TAP-10 §4): containers, holders, signers and channel keys all come from `api.resolve` / `api.chain.channelKeys`; nothing believes what a request or message says about itself.

## 缺口：容器互通今天还缺什么 / Gaps: what container interop still lacks today

每条标一个结论：**需要新规范**（格式或语义要有人定）/ **只需 SDK**（规范够了，SDK 补功能）/ **只需示例**（SDK 已有，缺的是演示）。这是本示例做下来的观察，不是路线承诺。
Each row ends in one verdict: **needs a new specification** (someone has to define a format or a meaning) / **SDK only** (the specifications suffice; the SDK lacks a feature) / **example only** (the SDK has it; what is missing is a demonstration). These are observations from building this example, not a plan.

| # | 缺口 / gap | 今天 / today | 结论 / verdict |
|---|---|---|---|
| 1 | **按名字发现**：已知 B 的链上名字，找到它的清单、任务种类与通道密钥。/ **Discovery by name**: B's on-chain name is known; find its manifest, task kinds and channel keys. | `api.resolve`、清单里可选的 `agent` 成员（`validateAgentMember`）、`api.chain.channelKeys` 都在；(c) 用到了后者。/ `api.resolve`, the optional `agent` member of the manifest (`validateAgentMember`) and `api.chain.channelKeys` exist; (c) uses the last. | 只需示例 / example only |
| 2 | **按能力发现**：不知道名字，要找"谁做这类任务"。/ **Discovery by capability**: no name known; find "who does this kind of task". | 没有目录：目录合约是实验性的、没有部署；#41 的第 3 部分（清单成员与列表）不在 #47 里。/ No directory: the directory contract is experimental and not deployed; part 3 of #41 (the manifest member and listings) is not in #47. | 需要新规范 / needs a new specification |
| 3 | **撤销**：停下一个遵守的代理容易；停下已发出的授权难。/ **Revocation**: stopping a compliant agent is easy; withdrawing authority already issued is not. | 消息与站点清单只约束读到它的一方；代理每一步都重读。会话钥匙不能撤销，只能等过期；B 从不知道撤销。/ A message and the site list bind only whoever reads them; the agent re-reads at every step. A session key cannot be revoked, only outlived; B never learns of a revocation. | 需要新规范 / needs a new specification |
| 4 | **方法级授权**：只允许 B 的 `quote`，不允许 B 的 `cancel`。/ **Method-level authorisation**: allow B's `quote` and not B's `cancel`. | 授权书的 scope 只到容器（加 cap），没有方法列表；B 看不到授权书；免费调用不带调用方身份（阶段 0 里持有授权书即可取交付物）。/ A mandate's scope goes down to the container (and a cap), with no method list; B does not see the mandate; a free call carries no caller identity (in phase 0 holding the mandate is enough to fetch a deliverable). | 需要新规范 / needs a new specification |
| 5 | **请求方的签名与回执的绑定**：B 想向第三方证明"A 问过这个"。/ **A caller's signature, and a receipt bound to a request's origin**: B wants to show a third party that A asked this. | 回执只含 B 的签名；A 没有签请求；通道的验证是对称的（共用密钥）；回执不含通道号。/ A receipt holds only B's signature; A signed nothing over the request; the channel's authentication is symmetric (shared keys); the receipt carries no channel id. | 需要新规范 / needs a new specification |
| 6 | **跨容器会话**：一串调用属于同一件事，B 能知道。/ **A session across containers**: a series of calls belongs to one matter, and B can know it. | 每次调用各自独立；线程只在代理运行时与委托方之间（按 nonce）；B 看不到线程。/ Every call stands alone; the thread exists only between the agent runtime and the principal (by nonce); B does not see it. | 需要新规范 / needs a new specification |
| 7 | **速率与配额**：B 按"调用方"或"授权"限量。/ **Rates and quotas**: B limits by caller or by authorisation. | provider 的限流按 IP 与付款方分桶；`maxCalls` 是代理运行时自己的；付费调用的总量由 cap 兜住；免费方法没有按授权的配额。/ A provider's rate limits are per IP and per payer; `maxCalls` is the agent runtime's own; paid calls are bounded by the cap; a free method has no quota by authorisation. | 需要新规范 / needs a new specification |
| 8 | **错误约定**：A 的代理被拒绝时，调用方怎么区分"请求格式错"与"授权不成立"。/ **Error conventions**: telling "malformed request" from "authorisation does not hold". | TAP-13 §6 的表里 `BAD_REQUEST` 的 `error.data` 一栏是 None；`examples/agent-service` 的运行时却用 `BAD_REQUEST` 加 `data.reason` 表示业务拒绝（`mandate-refused`、`mandate-revoked`、`spend-stopped`…），严格按 TAP-13 读的客户端会把它当成"请求格式错"。/ the `error.data` column for `BAD_REQUEST` in the TAP-13 §6 table says None, while the `examples/agent-service` runtime answers business refusals with `BAD_REQUEST` and `data.reason` (`mandate-refused`, `mandate-revoked`, `spend-stopped`, …); a client reading TAP-13 strictly takes them for "malformed request". | 需要新规范 / needs a new specification |
| 9 | **任务线程的承载**：把 `tape.agent/*` 线程放进私密通道或 TapeSend。/ **Carriage of the task thread**: putting the `tape.agent/*` thread in a private channel or TapeSend. | #47 只规定经 TAP-13 调用的承载，其余明说不在范围内；(c) 的请求/回答成帧是示例自己的。/ #47 specifies the carriage by TAP-13 calls only and says the rest is out of scope; (c)'s request/answer framing is the example's own. | 需要新规范 / needs a new specification |
| 10 | **转授权与多跳**：B 为 A 再去调用 C，并向 A 证明。/ **Sub-delegation and several hops**: B calls C for A and shows A. | 授权书的 `subdelegate` 必须为 false；链式授权没有格式。B 自己是代理时，C 的回执可以放进 B 的交付，仅此。/ A mandate's `subdelegate` must be false; there is no format for a chain of authority. When B is the agent, C's receipts can go in B's delivery, and that is all. | 需要新规范 / needs a new specification |
| 11 | **通道会话的持久化**：进程重启后接着用同一条通道。/ **Persisting a channel session**: carrying on with the same channel after a restart. | 通道会话只在内存里，没有快照与恢复接口（群有 `resumeGroup`）；重启就要重新握手。/ A channel session lives in memory, with no snapshot or resume API (a group has `resumeGroup`); a restart means a new handshake. | 只需 SDK / SDK only |
| 12 | **事后核验花费线程**：花光 cap 或收尾取回之后，第三方仍能核验整条线程。/ **Verifying a spend thread afterwards**: after the cap is spent or the channel closed out, a third party can still verify the whole thread. | 线程核验读的是此刻的通道（测试 `a: a cap spent in full…`、`a: after close-out…`）：报 `channel-empty` / `session-missing`，线程停在 `Accepted`。回执与交付的签名仍可核验。/ The thread check reads the channel as it is now (tests `a: a cap spent in full…`, `a: after close-out…`): it says `channel-empty` / `session-missing` and the thread stays `Accepted`. The receipts and the delivery's signature still verify. | 只需 SDK / SDK only |
| 13 | **多进程与重启的状态**：nonce 存储、撤销下限、限额记录。/ **State across processes and restarts**: the nonce store, the revocation floor, the limiter's records. | 默认在内存里；阶段 1 的状态目录（`examples/agent-service/state.mjs`）覆盖单进程重启；多进程共享要自己提供原子存储。/ In memory by default; the phase-1 state directory (`examples/agent-service/state.mjs`) covers a single process's restart; sharing across processes needs a store you provide that is atomic. | 只需 SDK / SDK only |

## 文件 / Files

| 文件 / file | 作用 / what it is |
|---|---|
| `world.mjs` | 本地世界：agent-service 的假链世界加中继（#15）、容器 B（#16）与两份通道记录 / the local world: the agent-service fake-chain world plus the relay (#15), container B (#16) and two channel records |
| `receipts.mjs` | `verifyReceipt`：对一张回执做 `api.call` 对每个回答做的检查，事后重做 / `verifyReceipt`: the check `api.call` makes on every answer, made again later on a receipt |
| `spend-call.mjs`, `spend-call.test.mjs` | 场景 (a) / scenario (a) |
| `task-thread.mjs`, `task-thread.test.mjs` | 场景 (b) / scenario (b) |
| `private-exchange.mjs`, `private-exchange.test.mjs` | 场景 (c) / scenario (c) |
| `run.mjs`, `run.test.mjs` | 命令行入口与它的测试，含源码扫描 / the command-line entry and its tests, with a source scan |

## 密钥 / Keys

只用假链的夹具密钥（测试辅助里的 `0x11…`、`0x22…`，以及 `world.mjs` 里的重复字节）：它们在任何真链上都不存在、不保护任何东西。**永远不要用真实钱包的私钥**，也不要把这些夹具密钥用到真链上。示例从不读取、从不要求任何私钥。
Only the fake chain's fixture keys are used (`0x11…`, `0x22…` of the test helpers, and the repeated bytes in `world.mjs`): they exist on no real chain and guard nothing. **Never use a real wallet's key**, and never reuse these fixtures on a real chain. The example never reads or asks for a private key.
