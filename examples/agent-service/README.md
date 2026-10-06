# 容器代理示例 / Container agent example (experimental)

**实验性（1.7，阶段 0）。** 一个"容器 + 代理 = 容器代理"的最小可运行示例：一个代理运行时（`index.mjs` + `agent.mjs`）和委托方的雇佣脚本（`hire.mjs`）。基于 `@tapeapi/sdk/agent`，该子路径整体是实验性的，**不受 1.x 兼容承诺约束**；格式跟随公开讨论 TapeOutProtocol/TAPs#40（授权书）与 #41（任务协议），可能随之改变。示例不在 npm 包里，运行时也不在 `@tapeapi/server` 里。

**Experimental (1.7, phase 0).** A minimal runnable example of "container + agent = container agent": an agent runtime (`index.mjs` + `agent.mjs`) and the principal's hiring script (`hire.mjs`). It is built on `@tapeapi/sdk/agent`, a subpath that is experimental as a whole and **outside the 1.x compatibility promise**; the formats follow the public discussions TapeOutProtocol/TAPs#40 (mandate) and #41 (task protocol) and may change with them. The example is not in the npm package, and the runtime is not part of `@tapeapi/server`.

## 先读这几句 / Read this first

- **阶段 0 的授权书只是"受托声明"，不是门禁。** 持有人签名的 `Mandate` 写明：谁委托谁、做什么任务、可以调用哪些服务。**没有任何东西强制执行它**（`enforcement: none`，每个核验结果都这样写）；因此任何写了金额的授权书一律被拒绝：`scope[].cap` 与 `feeCap` **必须为 0**（`phase0-no-funds`）。付款是一笔普通转账，与授权书无关。
- **"自雇自"会被标出来，不会被隐藏或拒绝。** 委托方与代理的容器相同、或持有人相同、或代理的签名者/执行钥匙就是委托方持有人，线程核验结果的 `selfHire` 为 `true` 并列出原因（`same-container`、`same-holder`、`agent-signer-is-principal-holder`、`agent-key-is-principal-holder`）。信誉类规则应排除这样的线程。`node examples/agent-service/hire.mjs --same-holder` 演示它。无法从协议上阻止，只能标出。
- **回执只证明"这些调用被这些容器回答并签名过"，不证明"活儿做对了"。** 交付里带的是代理从上游拿到的**只含哈希**的回执：每次调用确实由所列容器在所述时间签名回答过；不证明调用是必要的、回答是对的、交付物是正确或完整的。
- 任务文本、交付物、上游回答一律当**数据**：展示时用 `plainText`（TAP-10 §16，去掉双向控制符与不可见字符），从不当指令，从不用来选服务、选方法或选收款地址。

- **A phase-0 mandate is only a declaration of what was entrusted, not a gate.** The holder-signed `Mandate` states who entrusts whom with which task and which services may be called. **Nothing enforces it** (`enforcement: none`, which every check result says); so a mandate that names any amount is refused: every `scope[].cap` and `feeCap` **MUST be 0** (`phase0-no-funds`). Payment is a plain transfer, unrelated to the mandate.
- **A self-hire is flagged, not hidden or refused.** When principal and agent are the same container, the same holder, or the agent's signer or execution key is the principal's holder, the thread check's `selfHire` is `true` with the reasons (`same-container`, `same-holder`, `agent-signer-is-principal-holder`, `agent-key-is-principal-holder`). Reputation rules should exclude such threads. `node examples/agent-service/hire.mjs --same-holder` shows it. The protocol cannot prevent it, only mark it.
- **A receipt proves "these calls were answered, and signed, by these containers", not that the work is right.** A delivery carries the **hash-only** receipts the agent got from its upstreams: each listed call was signed by the named container at the stated time; this does not prove the calls were needed, the answers right, or the deliverable correct or complete.
- Task text, deliverables and upstream answers are all **data**: shown with `plainText` (TAP-10 §16: bidirectional controls and invisible characters removed), never obeyed, never used to choose a service, a method or a payee.

## 阶段 0 的规则（核心库强制，示例照办）/ Phase-0 rules the SDK enforces (and the example follows)

- 授权书里**每个 `scope[].token` 与 `feeToken` 必须是零地址**，cap 与 `feeCap` 必须为 0，`subdelegate` 必须为 false（`phase0-no-funds`、`subdelegate-not-allowed`）。**签名这一侧也有闸门**：`mandateTypedData` 与 `signMandate` 默认直接拒绝这样的授权书（`AGENT_INVALID`），示例从不传 `{ allowFunds: true }`（测试扫描源码确认）。
- 授权书的 `nonce` 必须等于报价的 `nonce`（否则 `mandate-mismatch`，线程不进 Active）；代理在开工前自己也核对这一点。
- 报价里的 `fee` 只是价格陈述：非零时 `taskOfferTypedData` 附带 `warnings`，**只给控制台看，交给钱包前去掉**（用 SDK 导出的 `forWallet`：`payload` 只含 domain、types、primaryType、message 四个键）；`feeToken` 恒为零地址，`--pay` 的金额也不写进报价。
- 付款：`viaContainer` 只接受本工具 `transferToContainer` 原样返回的对象（手搓或改过的一律 `recipient-not-from-chain`）；收款人必须是已铸造的 #ID（`recipientOf` 严格读 `ownerOf`，否则 `no-such-token`），结果带 `recipient.holder`，打印在逐字段摘要里。转账被回滚、取消或加速时，用 `paymentOrder().dropTransfer / replaceTransfer`（脚本只走顺利路径）。`--via-container` 不带外层 `value`，摘要会警告：真实链上容器的 `execute` 可能要求 TapeOut 费（见 `docs/guides/zh-CN/container-agents.md`，`viaContainer` 的 `value` 选项），这里的假链不收。
- `forWallet(td, { chainId, hub })` 的**第二参数必传**：它是控制台自己配置的链与 hub（`hire()` 的 `expect`，默认取委托方 kit 的配置，**不从待签载荷里取**，否则就是自己跟自己比对）；缺失、形状不对或与载荷的 `domain` 不一致都抛 `AGENT_INVALID`（载荷被换成另一条链或另一个 hub，签名就能在那里被重放）。返回的 `warnings` 与 `display` 是 SDK 重算的，不取输入里的；带任务原文的授权书，原文必须对得上 `taskHash`。
- `mandateTypedData` 的结果总带 `warnings` 与 `display`（传 `{ task }` 时 `display` 里是核对过哈希的任务原文与用文字写的日期，原文对不上 `taskHash` 会抛 `AGENT_INVALID`）；它们和 `forWallet` 的用法见 `hire.mjs`：签名前打印载荷、控制台提示与显示，三者分开。
- 授权书里写错了就不会用掉报价的 nonce（改正后可用同一 nonce 重签）的有两类：(1) 与报价不符的 principal、任务、mode、nonce：代理在读链之前先比对这四项；(2) 内核在持有人签名成立之后、因下列问题**不记录** nonce 的：`phase0-no-funds`、`subdelegate-not-allowed`、`mandate-too-long`（超过 30 天）、`agent-key-mismatch`、`agent-mismatch`。**`mandate-expired` 与 `mandate-not-yet` 仍然会记录 nonce**：那是持有人真实签发、只是在另一时间有效的授权书，改正时要换新的报价与 nonce。持有人签名不成立的授权书从不记录。（核对对象：核心 4a25477 的 `NONCE_BLOCKING`。）
- 站点上的撤销清单用 `revocationFileBytes({ chainId, revocation, sig })` 生成（紧凑、检查尺寸），不要自己 `JSON.stringify`。`tokenId` 只接受无前导零的十进制字符串、安全整数或 bigint，且 ≥ 1。
- `createAgentKit` 的 `nonces` 只接受 `Map` 或带 `setIfAbsent(key, value)`（返回先前值，一步完成）的存储，不再接受 `{ get, set }`；撤销清单一次最多 24 个哈希（更多就按日期 `revokedBefore`）。

- **Every `scope[].token` and `feeToken` in a mandate MUST be the zero address**, caps and `feeCap` 0, `subdelegate` false (`phase0-no-funds`, `subdelegate-not-allowed`). **The signing side has a gate too**: `mandateTypedData` and `signMandate` refuse such a mandate by default (`AGENT_INVALID`); the example never passes `{ allowFunds: true }` (a test scans the source for it).
- A mandate's `nonce` MUST equal the offer's (else `mandate-mismatch` and the thread never becomes Active); the agent checks it itself before starting.
- An offer's `fee` is only a price statement: a non-zero one makes `taskOfferTypedData` attach `warnings`, **for the console only, removed before the payload goes to a wallet** (the SDK's `forWallet`: `payload` holds only domain, types, primaryType and message); `feeToken` is always the zero address, and the `--pay` amount is not written into the offer.
- Payment: `viaContainer` takes only the very object `transferToContainer` returned (a hand-made or edited one is `recipient-not-from-chain`); the payee must be a minted #ID (`recipientOf` reads `ownerOf` strictly, else `no-such-token`), and the result carries `recipient.holder`, shown in the field-by-field summary. When the transfer reverts, is cancelled or is sped up, use `paymentOrder().dropTransfer / replaceTransfer` (the script follows the happy path only). `--via-container` passes no outer `value`, so the summary warns that a real chain's container `execute` may require the TapeOut fee (see `docs/guides/container-agents.md`, the `value` option of `viaContainer`); the fake chain here charges none.
- `forWallet(td, { chainId, hub })` **requires its second argument**: the chain and hub the console itself is configured for (`hire()`'s `expect`, by default the principal's kit, **never read from the payload about to be shown**, which would compare it with itself); a missing or malformed one, or one that differs from the payload's `domain`, throws `AGENT_INVALID` (a payload swapped to another chain or hub could be replayed there). The `warnings` and `display` it returns are recomputed by the SDK, never taken from the input; a mandate shown with its task text needs the text to hash to `taskHash`.
- `mandateTypedData` always returns `warnings` and `display` (with `{ task }`, `display` holds the task text checked against its hash and the dates in words; a text that does not hash to `taskHash` throws `AGENT_INVALID`); `hire.mjs` shows how to use them with `forWallet`: before signing it prints the payload, the console notices and the display, kept apart.
- A mandate that is mistaken does not use up the offer's nonce (the corrected one can be signed with the same nonce) in two kinds of case: (1) a principal, task, mode or nonce that differs from the offer: the agent compares these four before reading the chain; (2) a mandate the kit does not record the nonce of, once the holder's signature holds, because of: `phase0-no-funds`, `subdelegate-not-allowed`, `mandate-too-long` (over 30 days), `agent-key-mismatch`, `agent-mismatch`. **`mandate-expired` and `mandate-not-yet` still record the nonce**: such a mandate is a real one the holder issued, valid at another time, so correct it under a new offer and nonce. A mandate whose holder signature does not hold never records one. (Checked against the core at 4a25477, `NONCE_BLOCKING`.)
- The principal's revocation list on its site is made with `revocationFileBytes({ chainId, revocation, sig })` (compact, size-checked), not with a hand-made `JSON.stringify`. A `tokenId` is a decimal string without leading zeros, a safe integer or a bigint, and at least 1.
- `createAgentKit`'s `nonces` is a `Map` or a store with `setIfAbsent(key, value)` (returns the previous value, one atomic step), no longer `{ get, set }`; a revocation list holds at most 24 hashes (revoke more at once by date, `revokedBefore`).

## 运行 / Run

在仓库根目录（先 `npm install --no-audit --no-fund` 一次），Node 20+。不联网、不花钱、不碰真实钱包：全部发生在 SDK 的**假链**上（测试辅助），密钥是假链夹具；假链有自己的日历（时钟固定在夹具的 NOW，不读墙钟）。
From the repository root (`npm install --no-audit --no-fund` once), Node 20+. No network, no cost, no real wallet: everything happens on the SDK's **fake chain** (a test helper) with the fake chain's fixture keys; the fake chain has its own calendar (its clock is fixed at the fixture's NOW, never the wall clock).

```bash
node examples/agent-service/hire.mjs                 # the whole job: offer, accept, mandate, delivery, thread check, verdict
node examples/agent-service/hire.mjs --same-holder   # the same job as a self-hire: selfHire true (same-holder)
node examples/agent-service/hire.mjs --pay           # + the payment branch: UNSIGNED transactions only
node examples/agent-service/hire.mjs --pay --via-container   # the ERC-20 through the principal container's execute()
node --test examples/agent-service/agent-service.test.mjs   # end-to-end tests on the fake chain
node examples/agent-service/index.mjs                # the runtime alone, dev mode, :8799 (see below)
```

`index.mjs` 与其它示例一样，不设环境变量就以 dev 模式启动（临时 signer，`dev: true` 清单）。上线需要真实的容器、委托与 `https` 端点：`CONTAINER`、`CIRCUITS`、`TOKEN_ID`、`SIGNER_KEY`、`DELEGATION_SIG`、`DELEGATION_EXPIRES`、`PUBLIC_URL`（同 `examples/reader-service`）；`RPC_URLS`（至少两家运营方的节点）供运行时读链核验与调用授权书里列出的服务；`READ_METHOD` 是它对这些服务调用的方法（默认 `blockNumber`，即 `examples/reader-service` 提供的那个）。订单只存在内存里，重启即忘。
Like the other examples, `index.mjs` starts in dev mode with no environment (ephemeral signer, `dev: true` manifest). Going live needs a real container, a delegation and an `https` endpoint: `CONTAINER`, `CIRCUITS`, `TOKEN_ID`, `SIGNER_KEY`, `DELEGATION_SIG`, `DELEGATION_EXPIRES`, `PUBLIC_URL` (as in `examples/reader-service`); `RPC_URLS` (nodes of at least two operators) lets the runtime read the chain for its checks and call the services a mandate lists; `READ_METHOD` is the method it calls on them (default `blockNumber`, as `examples/reader-service` serves it). Orders live in memory: a restart forgets them.

## 文件 / Files

| 文件 / file | 作用 / what it is |
|---|---|
| `agent.mjs` | 代理运行时 `createAgentService`：四个方法、`ctx.call`（**本示例自己的包装**，不是 `createProvider` 的功能）、示例任务 `chain.block-height` / the runtime: four methods, `ctx.call` (**this example's own wrapper**, not a `createProvider` feature), the example task |
| `index.mjs`, `manifest.json` | 服务入口（`createProvider` + `_lib/service.mjs` 的外壳）与清单（含可选的 `agent` 成员）/ the server entry and the manifest (with the optional `agent` member) |
| `hire.mjs` | 委托方脚本（不是 CLI）：`hire()`、`payBranch()`、`main()` / the principal's script (not a CLI) |
| `demo-world.mjs` | 假链世界：委托方 #11、代理 #12、服务 #13（授权书里）与 #14（不在）、进程内的 HTTP、模拟"持钱包的人" / the fake-chain world |
| `agent-service.test.mjs` | 端到端测试 / the end-to-end tests |

## 方法 / The methods

清单方法名不允许点号，所以用下划线。全部免费；描述以 `[no-quorum]` 开头：每个回答都签在自己的时刻，每单一把新钥匙，不能进 `callQuorum`。
Manifest method names cannot contain dots, hence the underscores. All free; their descriptions start with `[no-quorum]`: every answer is signed at its own time and every order gets a new key, so none can go through `callQuorum`.

| 方法 / method | 参数 / params | 做什么 / what it does |
|---|---|---|
| `task_offer` | `{ message }`：`tape.agent/offer` | 先 `verifyTaskThread([offer])`，必须 `Offered` 且 `ok`；报价必须点名本代理、任务种类必须受支持；为**这一单**生成新的 `agentKey`（每单一把、永不重用，只留地址，私钥随即丢弃：阶段 0 只绑定、不使用它）；回签名的 `tape.agent/accept`：`{ kind, offerHash, agentKey, exp }`。同一份报价再来，是同一单、同一把钥匙。/ `verifyTaskThread([offer])` must be `Offered` and `ok`; the offer must name this agent and a supported task kind; a **fresh** `agentKey` is made for this order (one per order, never reused; only the address is kept, the secret is dropped at once: phase 0 only binds it, never uses it); the answer is the signed `tape.agent/accept`. The same offer again is the same order and the same key. |
| `task_mandate` | `{ offerHash, message }`：`tape.agent/mandate` | `kit.verifyMandate(msg, { agentKey, agent: <本容器> })` 必须 `ok` 才开工：持有人签名、本单公布的 `agentKey`、本代理、有效期、每个 cap 为 0、未撤销、nonce 未重用；另核对与报价一致（委托方、任务哈希、mode）。否则回 `BAD_REQUEST`，`data.reason` 与 `data.problems` 说明原因，**不开工**。/ `kit.verifyMandate(...)` must be `ok` before any work: holder signature, the `agentKey` announced for this order, this agent, the window, every cap 0, not revoked, nonce unused; and it must match the offer. Otherwise `BAD_REQUEST` with `data.reason` and `data.problems`, and **no work starts**. |
| `task_deliver` | `{ mandateHash }` | 等任务完成，**交付前最后一次**重新核验授权书与撤销，然后回签名的 `tape.agent/deliver`：`{ kind, mandateHash, deliverableHash, receipts, receiptsHash, exp }`（`receipts` 是只含哈希的回执，`receiptsHash = jsonHashOf(receipts)`）。/ waits for the task, re-verifies the mandate and revocations **one last time before signing**, then answers the signed `tape.agent/deliver`. |
| `task_status` | `{ offerHash 或 mandateHash, mandate?, revocation? }` | 订单状态。带上**签名授权书本身**（持有人给委托方的那份文件，相当于持有凭证）才返回交付物；带上持有人签名的 `revocation` 消息则停止本单。/ the order's state. With the **signed mandate itself** (a bearer secret: phase 0 has no caller identity) it also returns the deliverable; with a holder-signed `revocation` message it stops the order. |

示例任务 `chain.block-height`：通过 `ctx.call` 对授权书 `scope[].provider` 列出的每个服务调用 `blockNumber`（方法名在代码里写死，不取自任务文本），把每个答案放进交付物。**只允许调用 scope 里列出的服务**：`ctx.call` 在发出任何请求之前就拒绝其它容器（`out-of-scope`）；每次调用的回执用 `mcp.hashReceipt(mcp.receiptOf(...))` 以只含哈希的形式收集。
The example task `chain.block-height`: through `ctx.call` it calls `blockNumber` on every provider the mandate's `scope[].provider` lists (the method is fixed in the code, never taken from the task text) and puts every answer in the deliverable. **Only services listed in scope may be called**: `ctx.call` refuses any other container before a request is made (`out-of-scope`); each call's receipt is collected hash-only with `mcp.hashReceipt(mcp.receiptOf(...))`.

## 撤销 / Revocation

收到撤销后代理停止，**不再签任何新的 `tape.agent/*` 消息**：每一步（每次上游调用之前、交付之前）都重新跑 `verifyMandate`，读委托方站点上的 `.well-known/tapeapi-mandates.json`（持有人签名的撤销清单），并应用收到的撤销消息（经 `task_status` 的 `revocation` 参数，或宿主程序调用 `service.receiveRevocation()`）。读不到可靠的撤销清单同样停止（失败关闭）。只被保留核验通过、且覆盖本单授权书的撤销消息，垃圾消息哪里都不保留。
After a revocation the agent stops and **signs no new `tape.agent/*` message**: every step (before each upstream call, before the delivery) runs `verifyMandate` again, reading the principal's `.well-known/tapeapi-mandates.json` (the holder-signed revocation list) and applying revocation messages received (the `revocation` parameter of `task_status`, or the host calling `service.receiveRevocation()`). A revocation list that cannot be relied on stops it too (fail closed). Only a revocation message that verifies and covers this order's mandate is kept; junk is kept nowhere.

诚实地说清楚：`createProvider` 对**每个**回答都签名，错误也一样，所以被拒绝的请求得到的是一个**签名的错误信封**，它不是线程消息（没有 `tape.agent/*` 的 `result.kind`，`verifyTaskThread` 不认）。检查发生在"那一刻"：阶段 0 没有强制执行，一毫秒之后才发布的撤销看不到。
To be plain: `createProvider` signs **every** answer, errors included, so a refused request gets a **signed error envelope**; it is not a thread message (no `tape.agent/*` `result.kind`, which `verifyTaskThread` does not accept). The check happens "at that moment": phase 0 has no enforcement, a revocation published a millisecond later is not seen.

## 付费支线 / The payment branch (`--pay`)

默认关闭。**只构造未签名交易并逐字段打印**（钱包读不懂容器 `execute` 的 calldata，所以每个字段都写出来供你和钱包对照）：`transferToContainer` 的 ERC-20 `transfer`，（`--via-container`）经委托方容器 `execute(token, 0, transfer(...), 0)`，以及携带转账的 TapeSend 消息（`encodeContent`，正文带 `verdictHash`，再 `tapesend.sendTx`）；用 `paymentOrder` 记录转账、确认、检查消息带齐。**不授权额度、不签名、不广播、不发任何交易**（`_lib/sendtx.mjs` 不被引用，测试断言源码里没有这些）。演示里"持钱包的人"由假链模拟（`demo-world.mjs` 的 `wallet`）：它解码交易自己的 calldata 再写入假链。收款方一侧用 `readMessage` + `verifyAttachments`（TAP-10 §19）核验，应得 `ok`。
**收款地址从不取自文本**，只取自链上：代理电路由 `identityOf` 读出，再由 `recipientOf` 经 `isCPU` 与 `hub.accountOf` 严格推导出容器地址（`identityOf` 已核对中枢推导出的正是报价里点名的代理容器）；SDK 本身也拒绝调用方传入的任何地址（`recipient-not-from-chain`）。
Off by default. It **only builds unsigned transactions and prints every field** (a wallet cannot read a container's `execute` calldata, so each field is written out for you to compare): the ERC-20 `transfer` from `transferToContainer`, (`--via-container`) through the principal container's `execute(token, 0, transfer(...), 0)`, and the TapeSend message that carries it (`encodeContent` with the `verdictHash` in the body, then `tapesend.sendTx`); `paymentOrder` records the transfer, confirms it and checks the message carries it. It **grants no allowance, signs nothing, broadcasts nothing, sends no transaction** (`_lib/sendtx.mjs` is not used, and a test asserts the source has none of these). In the demo the "human with a wallet" is simulated by the fake chain (`demo-world.mjs`, `wallet`), which decodes the transaction's own calldata and writes the result into the fake chain. The recipient's side uses `readMessage` + `verifyAttachments` (TAP-10 §19) and should say `ok`.
**The payee is never taken from a text**, only from the chain: the agent's circuit is read by `identityOf`, then `recipientOf` derives the container strictly through `isCPU` and `hub.accountOf` (`identityOf` already checked that the hub derives the very container the offer named); the SDK itself also refuses any address the caller hands over (`recipient-not-from-chain`).

## 密钥 / Keys

`hire.mjs` 只用假链的夹具密钥（`0x11…`、`0x22…`），仅限假链：**永远不要用真实钱包的私钥**，也不要把这些夹具密钥用到真链上。真实的委托方在钱包里对脚本打印的 typed data 用 `eth_signTypedData_v4` 签名，替换 `hire()` 的 `signer` 即可；脚本从不读取、从不要求任何私钥。
`hire.mjs` only uses the fake chain's fixture keys (`0x11…`, `0x22…`), for the fake chain only: **never use a real wallet's key**, and never reuse these fixtures on a real chain. A real principal signs the typed data the script prints in a wallet with `eth_signTypedData_v4`, by replacing `hire()`'s `signer`; the script never reads or asks for a private key.

## 限制 / Limits

- 没有强制执行（见上）；撤销只约束读到它的一方；核验看的是**当前**持有人，电路转手后旧持有人签的消息都不再通过。/ No enforcement (above); a revocation binds only whoever reads it; checks use the **current** holder, so messages signed by a former holder stop verifying when the circuit changes hands.
- 订单、撤销下限（`revocationFloor`）与 nonce 存储都在内存里：多进程或重启后，撤销清单的"只增不减"下限与 nonce 重用检测都会重新开始。正式部署要给 `createAgentKit` 持久的 `revocationFloor`（`{get,set}`）与 `nonces`（`Map` 或带 `setIfAbsent` 的存储）。/ Orders, the revocation floor and the nonce store live in memory: with several processes or after a restart the "issued only grows" floor and nonce-reuse detection start over. A real deployment gives `createAgentKit` a persistent `revocationFloor` (`{get,set}`) and `nonces` (a `Map`, or a store with `setIfAbsent`).
- 运行时最多在内存里保留 `maxOrders`（默认 1000）个订单，满了就回 `busy`，没有淘汰；它也没有给 `task_offer` 加任何准入限制（谁能付钱、付多少，由委托方与代理自己在链下谈）。/ The runtime keeps at most `maxOrders` (default 1000) orders in memory and answers `busy` when full; it never evicts, and it puts no admission rule on `task_offer` (who pays what is for principal and agent to settle off this protocol).
- 验收与拒收没有仲裁；`agentKey` 在阶段 0 只被绑定、不被使用。/ No arbiter for accept or reject; the `agentKey` is only bound in phase 0, never used.
