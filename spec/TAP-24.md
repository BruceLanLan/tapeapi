| TAP | 24 |
|---|---|
| Title | TapeAPI: Intent RFQ for Cross-Chain Exchange |
| Author | Bruce (@BruceLanLan) |
| Status | Withdrawn |
| Implementation | Withdrawn (2026-09-28), after being frozen since 2026-09-21 (see the status note); not a build target: no `IntentEscrow` exists or is deployed. `examples/defi-rfq-solver` builds and signs quotes (§3.2) only and moves no funds. |
| Type | Standards |
| Created | 2026-09-20 |
| Requires | TAP-20, TAP-21, TAP-23 |
| License | CC0-1.0 |

# TAP-24: TapeAPI: Intent RFQ for Cross-Chain Exchange

> English is authoritative. 中文译文见下半部分，章节编号一一对应。

> **Placeholder number.** TAP-24 is a placeholder number proposed in [TapeKit issue #8](https://github.com/TapeOutProtocol/TapeKit/issues/8). TapeKit has no numbered-proposal process yet (changes to TapeOut itself follow TapeKit `SPEC.md` §15), so the maintainers may assign another number or move this document to another process; see [TAP-1](TAP-1.md).

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in RFC 2119.

> **Status note (2026-09-21): FROZEN pending Tier 2 trust.** This proposal releases locked funds on the
> strength of TAP-23 attestations. TAP-23 explicitly defers staking and slashing, so those attestations are a
> Tier 1 guarantee (a client-chosen federation, no economic penalty for lying) while releasing funds requires
> Tier 2. Composing the two lets an attacker who controls two provider identities, at roughly 0.02 BNB, release
> arbitrary locked value. Nothing in this document may be implemented against real funds until a staking and
> slashing TAP exists and TAP-23 requires it for attestations that gate fund release. The design is kept so the
> interfaces can be reviewed; it is not a build target.
>
> **Withdrawn (2026-09-28).** The author has withdrawn this proposal: it is outside TapeAPI 1.0, and it stays
> withdrawn at least until a staking and slashing TAP exists. The text is kept for the record under TAP-1 §4.1; its
> number is not reused. A later proposal for the same flow is a new document.

## 1. Abstract

This TAP defines a request-for-quote flow in which a User obtains signed quotes from Solver services over TapeAPI, locks the input asset in a per-chain `IntentEscrow`, the Solver pays the output asset on the destination chain, and the lock is released to the Solver once TAP-23 Attested Reads show the payment was made. TapeAPI carries three kinds of data: the quote request, the signed quote, and the fulfilment attestation. It never holds pooled liquidity, never mints a wrapped asset, and has no relayer set.

## 2. Motivation

A User holding an asset on chain A who wants an asset on chain B is today served by bridges that pool liquidity and mint claims, or by intent protocols that each run their own solver registry and settlement. The first concentrates risk in a pool; the second fragments solvers by protocol. TapeAPI already provides solver discovery (TAP-20), signed and attributable responses (TAP-21), and block-anchored cross-chain reads (TAP-23). Combining them yields an RFQ network whose identity and payment live on-chain but which belongs to no single venue: any market maker, bridge, or exchange may register a circuit and quote.

## 3. Specification

### 3.1 Roles

- **User.** Requests quotes, locks `amountIn` on `fromChain`, receives `amountOut` on `toChain`.
- **Solver.** A TapeAPI service (TAP-20) offering a `quote` method. Signs quotes with a key it controls on `fromChain`, pays on `toChain`, and claims the lock.
- **Attester.** A TAP-23 Attested Read service. Chosen per intent by the User at lock time; the Solver inspects the choice before paying. Attesters are ordinary services, not a protocol-level set.

### 3.2 Quote Method

A Solver lists a method with an `intentRfq` object in its descriptor (TAP-20 §3.3):

```json
{ "name": "quote", "priceBEM": "0",
  "params": { "fromChain": "number", "fromToken": "address", "amountIn": "string",
              "toChain": "number", "toToken": "address", "recipient": "address" },
  "returns": { "quote": "object", "sig": "bytes65", "escrow": "address" },
  "intentRfq": { "routes": [ { "fromChain": 56, "toChain": 8453 } ] } }
```

`params` fields are as named; `amountIn` is a decimal string in the smallest unit of `fromToken`. `fromToken`/`toToken` equal to the zero address denote the chain's native coin. A Solver that does not serve the route MUST answer `METHOD_NOT_FOUND`. `result` MUST be `{ quote, sig, escrow }` where `quote` is the struct in §3.3, `sig` its signature, and `escrow` the `IntentEscrow` address on `fromChain`. A Solver MAY add informative fields beside these three (the reference Solver adds `typehash`, `digest` and `domain`); a client ignores them and computes the digest itself from `quote` and the domain of §3.3, never taking a Solver's `digest` in its place. The whole `result` is additionally covered by the TAP-21 envelope signature, binding the quote to the Solver's service identity.

### 3.3 Signed Quote

- Domain: `EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)` with `name = "IntentEscrow"`, `version = "1"`, `chainId = fromChain`, `verifyingContract = <IntentEscrow on fromChain>`.
- Primary type: `Quote(bytes32 quoteId,uint64 fromChain,address fromToken,uint256 amountIn,uint64 toChain,address toToken,uint256 amountOut,address recipient,uint64 expires,address solver)`.
- `QUOTE_TYPEHASH = keccak256(<primary type string>) = 0xe7c18a58c429974068166f7c27b8ba2a9a13177c83aeb69cdcac7a4bc7592d59`.
- `structHash = keccak256(abi.encode(QUOTE_TYPEHASH, quoteId, fromChain, fromToken, amountIn, toChain, toToken, amountOut, recipient, expires, solver))`; `digest = keccak256(0x1901 ‖ DOMAIN_SEPARATOR ‖ structHash)`.
- `quoteId` MUST be unique per Solver; RECOMMENDED `keccak256(solver ‖ random32)`. `expires` is Unix seconds; Solvers SHOULD use 30–120 s. `solver` is the address that signs the quote and receives the lock on `fromChain`; it MAY differ from the manifest `signer`.
- `sig` is 65 bytes `r ‖ s ‖ v`, `v ∈ {27, 28}`, low-`s`, and MUST recover to `solver`.

### 3.4 IntentEscrow Interface (sketch)

One non-upgradeable contract per supported chain, deployed at the same address via CREATE2 (as TAP-10 does for its hub). Interface, subject to change before Review:

```
lock(Quote q, bytes solverSig, address[] attesters, uint8 threshold) payable
  // User. Verifies q.fromChain == block.chainid, q.expires > now, sig recovers to q.solver,
  // quoteId unused. Pulls amountIn (transferFrom, or msg.value for native). threshold ≥ 2.
  // Stores Intent{ q, user, attesters, threshold, lockedAt }. Emits Locked(quoteId, ...).

pay(bytes32 quoteId, address toToken, uint256 amountOut, address recipient)
  // Solver, on toChain. Transfers amountOut to recipient and records
  // paid[quoteId] = keccak256(abi.encode(toToken, amountOut, recipient, msg.sender)). Emits Paid.

fulfil(bytes32 quoteId, Attestation[] a)
  // Anyone, on fromChain. Each Attestation is a TAP-23 read of paid[quoteId] on toChain at
  // IntentEscrow(toChain), signed by one of intent.attesters. Requires ≥ threshold distinct
  // attesters whose (chainId, blockHash, result) agree and whose result equals the expected
  // keccak256(toToken, amountOut, recipient, solver). Releases amountIn to q.solver. Emits Fulfilled.

refund(bytes32 quoteId)
  // User, after q.expires + REFUND_DELAY (RECOMMENDED 1 h) if not fulfilled. Emits Refunded.
```

`Attestation` carries the TAP-21 envelope components needed to recompute the digest on-chain (`container`, `id`, `ts`, `sig`, and the TAP-23 result fields), from which the contract rebuilds the canonical JSON of the result. The exact calldata layout is TODO before Review. `fulfil` MUST apply the TAP-23 §3.4 rule: any disagreement among the presented attestations MUST revert; the contract MUST NOT take a majority.

### 3.5 Flow

1. User calls `quote` on several Solvers via the SDK and picks one (§3.2).
2. User calls `lock` on `fromChain` with the quote, `solverSig`, and its chosen attesters (§3.4).
3. Solver observes `Locked`, checks the attester set is one it trusts, and calls `pay` on `toChain` before `q.expires`. A Solver that does not trust the attester set simply does not pay; the User refunds after the delay.
4. Anyone requests TAP-23 reads of `paid[quoteId]` from the attesters (pinned to a finalized block) and submits `fulfil` on `fromChain`.
5. If step 4 does not succeed before `q.expires + REFUND_DELAY`, the User calls `refund`.

### 3.6 What TapeAPI Does and Does Not Do

Does: Solver discovery (TAP-20); transport and attribution of quotes (TAP-21); an on-chain-enforceable quote signature (§3.3); fulfilment proof via Attested Read (TAP-23); metered payment for the `quote` and `read` calls themselves (TAP-22).

Does not: hold **pooled liquidity** (funds are locked per intent and belong to one User until fulfilled or refunded); mint **wrapped assets** (the User receives the native `toToken`); run a **relayer set** (attesters are chosen per intent by the parties; anyone may submit `fulfil`); route, split, or price orders (Solvers do); custody anything on `toChain` beyond the momentary `pay` transfer.

## 4. Rationale

- **Quote signed by `solver`, not by the manifest signer.** The escrow on `fromChain` cannot verify a TAP-20 delegation rooted on chainId 56. A plain key the Solver controls on `fromChain` is verifiable everywhere; the TAP-21 envelope still ties the quote to the service identity for discovery and disputes.
- **`pay` through the escrow on `toChain`.** Recording `paid[quoteId]` turns "was the transfer made?" into a single `eth_call`, which is exactly what TAP-23 attests. Reading raw transfer logs would need a receipt profile that TAP-23 does not yet define.
- **User picks attesters, Solver vetoes by not paying.** Both parties must accept the attester set, without a protocol registry. The Solver's only risk from a bad set is a lost opportunity, because it checks before paying.
- **Solver-owned liquidity.** UniswapX, Across, and CoW have shown intent-plus-solver flows carry real volume; the missing piece is a venue-neutral identity and payment layer, which is what TapeAPI supplies.

## 5. Backwards Compatibility

Adds a method-descriptor field and a contract interface. Adds nothing to `SPEC.md`, does not alter the name grammar `<#ID>.<processor>.tape`, and does not alter any §15.1 invariant. TAP-22 vouchers are unchanged; `quote` and `read` calls are ordinary TAP-21 calls.

## 6. Test Vectors

| Item | Value |
|---|---|
| `QUOTE_TYPEHASH` | `0xe7c18a58c429974068166f7c27b8ba2a9a13177c83aeb69cdcac7a4bc7592d59` |
| `keccak256("IntentEscrow")` | `0x2043479336d59fcf0f30222e9c9f674b6a85c2fa5b5033d0c47e20469de7f0ba` |
| Worked quote digest and signature | TODO before Final |
| IntentEscrow address (CREATE2) | TODO (not deployed) |

## 7. Reference Implementation

- `IntentEscrow` and a full Solver reference implementation are v0.4 deliverables (`docs/CROSSCHAIN.md` §5) and do not exist (2026-09-27).
- `examples/defi-rfq-solver` is an example Solver that builds and signs quotes only: `quote.mjs` holds the type string, `QUOTE_TYPEHASH` and the domain, checked against §6 at start-up. It locks and releases nothing.
- The SDK has no quote code yet; quote construction and verification will live in `sdk/` alongside the TAP-22 voucher code.

## 8. Security Considerations

- **Solver non-performance.** Bounded by `expires + REFUND_DELAY`; the User's funds are never at risk beyond the delay.
- **Attester collusion.** If `threshold` attesters lie, `fulfil` releases funds to a Solver that did not pay. Users MUST choose attesters that are independent per TAP-23 §3.5 and SHOULD prefer `threshold ≥ 3` for large amounts. The Solver faces the mirror risk (attesters refuse to attest a real payment) and mitigates it by vetting the set before `pay`.
- **Quote replay.** `chainId` and `verifyingContract` in the domain, plus one-time `quoteId`, prevent reuse across chains, escrows, and intents.
- **Front-running `pay`.** A third party paying `recipient` does not create `paid[quoteId]` under the Solver's address, so it cannot redirect the lock. The `msg.sender` inside the recorded hash MUST be checked against `q.solver` by `fulfil`.
- **Reorg on `toChain`.** Attesters SHOULD read at a finalized block; `fulfil` SHOULD reject attestations whose `blockNumber` is younger than a per-chain finality depth.
- **Token behaviours.** Fee-on-transfer or rebasing tokens break `amountIn`/`amountOut` equality; deployments SHOULD whitelist tokens or document the exclusion.

## 9. Copyright

Copyright and related rights waived via CC0-1.0.

---

# TAP-24：TapeAPI：跨链兑换的意图询价（中文译文）

> 英文为权威文本，本译文与英文章节一一对应。

> **占位编号。** TAP-24 是在 [TapeKit issue #8](https://github.com/TapeOutProtocol/TapeKit/issues/8) 中提议的占位编号。TapeKit 目前还没有编号提案流程（对 TapeOut 本身的修改遵循 TapeKit `SPEC.md` §15），因此维护者可能另行分配编号，或把本文档移入其它流程；见 [TAP-1](TAP-1.md)。

> **实现状态（2026-09-28）：** 已撤回（2026-09-28），此前自 2026-09-21 起冻结（见状态说明）；不是构建目标：`IntentEscrow` 不存在，也未部署。`examples/defi-rfq-solver` 只构造并签署报价（§3.2），不移动任何资金。

本文档中的关键词 "MUST"（必须）、"MUST NOT"（禁止）、"REQUIRED"（必需）、"SHALL"、"SHOULD"（应当）、"SHOULD NOT"（不应）、"RECOMMENDED"（推荐）、"MAY"（可以）、"OPTIONAL"（可选）按 RFC 2119 解释。

> **状态说明（2026-09-21）：冻结，待二级信任就绪。** 本提案依据 TAP-23 的证明来释放锁定资金。
> TAP-23 明确推迟了质押与罚没，因此其证明只是一级保证（调用方自选的联盟，说谎无经济代价），
> 而释放资金需要二级保证。把两者组合起来，控制两个提供者身份（约 0.02 BNB）的攻击者即可释放任意锁定资产。
> 在质押与罚没的 TAP 出现、且 TAP-23 要求用于释放资金的证明必须来自质押提供者之前，
> 本文任何内容都不得面向真实资金实现。保留设计以便审阅接口；它不是构建目标。
>
> **已撤回（2026-09-28）。** 作者已撤回本提案：它不在 TapeAPI 1.0 范围内，至少在质押与罚没的 TAP 出现之前
> 保持撤回。文本按 TAP-1 §4.1 保留备查，编号不复用。以后针对同一流程的提案将是一份新文档。

## 1. 摘要

本 TAP 定义一个询价（RFQ）流程：用户经 TapeAPI 从 Solver 服务获取签名报价，将输入资产锁入各链一份的 `IntentEscrow`，Solver 在目标链支付输出资产，待 TAP-23 见证读取表明付款已完成后，锁定资产释放给 Solver。TapeAPI 只承载三类数据：询价请求、签名报价、履约证明。它从不持有资金池、从不铸造包装资产、没有中继者集合。

## 2. 动机

持有链 A 资产、想要链 B 资产的用户，今天要么使用汇集流动性并铸造凭证的桥，要么使用各自运行 Solver 注册表与结算的意图协议。前者将风险集中于资金池；后者按协议割裂 Solver。TapeAPI 已经提供 Solver 发现（TAP-20）、签名可归属的响应（TAP-21）与锚定区块的跨链读取（TAP-23）。三者组合得到一个身份与支付都在链上、却不属于任何单一场所的 RFQ 网络：任何做市商、桥或交易所都可以注册一个电路来报价。

## 3. 规范

### 3.1 角色

- **用户（User）。** 询价，在 `fromChain` 锁定 `amountIn`，在 `toChain` 收到 `amountOut`。
- **Solver。** 提供 `quote` 方法的 TapeAPI 服务（TAP-20）。以其在 `fromChain` 上控制的密钥签署报价，在 `toChain` 付款，并领取锁定资产。
- **见证者（Attester）。** TAP-23 见证读取服务。由用户在锁定时按意图选择；Solver 在付款前审视该选择。见证者是普通服务，不是协议级集合。

### 3.2 报价方法

Solver 在其描述符（TAP-20 §3.3）中列出带 `intentRfq` 对象的方法：

```json
{ "name": "quote", "priceBEM": "0",
  "params": { "fromChain": "number", "fromToken": "address", "amountIn": "string",
              "toChain": "number", "toToken": "address", "recipient": "address" },
  "returns": { "quote": "object", "sig": "bytes65", "escrow": "address" },
  "intentRfq": { "routes": [ { "fromChain": 56, "toChain": 8453 } ] } }
```

`params` 字段如其名；`amountIn` 为以 `fromToken` 最小单位计的十进制字符串。`fromToken`/`toToken` 为零地址表示该链原生币。不服务该路线的 Solver MUST 回应 `METHOD_NOT_FOUND`。`result` MUST 为 `{ quote, sig, escrow }`，其中 `quote` 为 §3.3 的结构体，`sig` 为其签名，`escrow` 为 `fromChain` 上的 `IntentEscrow` 地址。Solver MAY 在这三个字段之外附加信息性字段（参考 Solver 附加了 `typehash`、`digest` 与 `domain`）；客户端忽略它们，自己根据 `quote` 与 §3.3 的域计算摘要，绝不用 Solver 给出的 `digest` 代替。整个 `result` 另受 TAP-21 信封签名覆盖，将报价绑定到 Solver 的服务身份。

### 3.3 签名报价

- 域：`EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)`，其中 `name = "IntentEscrow"`、`version = "1"`、`chainId = fromChain`、`verifyingContract = <fromChain 上的 IntentEscrow>`。
- 主类型：`Quote(bytes32 quoteId,uint64 fromChain,address fromToken,uint256 amountIn,uint64 toChain,address toToken,uint256 amountOut,address recipient,uint64 expires,address solver)`。
- `QUOTE_TYPEHASH = keccak256(<主类型字符串>) = 0xe7c18a58c429974068166f7c27b8ba2a9a13177c83aeb69cdcac7a4bc7592d59`。
- `structHash = keccak256(abi.encode(QUOTE_TYPEHASH, quoteId, fromChain, fromToken, amountIn, toChain, toToken, amountOut, recipient, expires, solver))`；`digest = keccak256(0x1901 ‖ DOMAIN_SEPARATOR ‖ structHash)`。
- `quoteId` 对每个 Solver MUST 唯一；RECOMMENDED `keccak256(solver ‖ random32)`。`expires` 为 Unix 秒；Solver SHOULD 使用 30–120 秒。`solver` 为签署报价并在 `fromChain` 上接收锁定资产的地址；MAY 不同于清单 `signer`。
- `sig` 为 65 字节 `r ‖ s ‖ v`，`v ∈ {27, 28}`，低 `s`，且 MUST 恢复为 `solver`。

### 3.4 IntentEscrow 接口（草图）

每条支持的链上一个不可升级合约，经 CREATE2 部署于相同地址（同 TAP-10 对其 hub 的做法）。接口在 Review 前可能变更：

```
lock(Quote q, bytes solverSig, address[] attesters, uint8 threshold) payable
  // 用户调用。校验 q.fromChain == block.chainid、q.expires > now、签名恢复为 q.solver、
  // quoteId 未用过。拉取 amountIn（transferFrom，原生币则为 msg.value）。threshold ≥ 2。
  // 存储 Intent{ q, user, attesters, threshold, lockedAt }。发出 Locked(quoteId, ...)。

pay(bytes32 quoteId, address toToken, uint256 amountOut, address recipient)
  // Solver 在 toChain 调用。向 recipient 转 amountOut，并记录
  // paid[quoteId] = keccak256(abi.encode(toToken, amountOut, recipient, msg.sender))。发出 Paid。

fulfil(bytes32 quoteId, Attestation[] a)
  // 任何人在 fromChain 调用。每个 Attestation 是对 toChain 上 IntentEscrow(toChain) 的
  // paid[quoteId] 的一次 TAP-23 读取，由 intent.attesters 之一签名。要求 ≥ threshold 个
  // 不同见证者，其 (chainId, blockHash, result) 一致且 result 等于预期的
  // keccak256(toToken, amountOut, recipient, solver)。将 amountIn 释放给 q.solver。发出 Fulfilled。

refund(bytes32 quoteId)
  // 用户在 q.expires + REFUND_DELAY（RECOMMENDED 1 小时）后、未履约时调用。发出 Refunded。
```

`Attestation` 携带在链上重算摘要所需的 TAP-21 信封组件（`container`、`id`、`ts`、`sig` 及 TAP-23 结果字段），合约据此重建结果的规范 JSON。精确的 calldata 布局为 Review 前 TODO。`fulfil` MUST 应用 TAP-23 §3.4 的规则：所提交见证之间任何不一致 MUST 回滚；合约 MUST NOT 取多数。

### 3.5 流程

1. 用户经 SDK 向多个 Solver 调用 `quote` 并选定一个（§3.2）。
2. 用户在 `fromChain` 以报价、`solverSig` 及其选定的见证者调用 `lock`（§3.4）。
3. Solver 观察到 `Locked`，检查见证者集合是否为其信任，并在 `q.expires` 前于 `toChain` 调用 `pay`。不信任该见证者集合的 Solver 只需不付款；用户在延迟期后取回。
4. 任何人向见证者请求对 `paid[quoteId]` 的 TAP-23 读取（固定到已最终确认的区块），并在 `fromChain` 提交 `fulfil`。
5. 若步骤 4 未在 `q.expires + REFUND_DELAY` 前成功，用户调用 `refund`。

### 3.6 TapeAPI 做什么、不做什么

做：Solver 发现（TAP-20）；报价的传输与归属（TAP-21）；可在链上强制执行的报价签名（§3.3）；经见证读取的履约证明（TAP-23）；对 `quote` 与 `read` 调用本身的计量支付（TAP-22）。

不做：持有**资金池**（资金按意图锁定，在履约或退款前始终属于单个用户）；铸造**包装资产**（用户收到原生 `toToken`）；运行**中继者集合**（见证者由交易双方按意图选择；任何人都可提交 `fulfil`）；路由、拆单或定价（由 Solver 完成）；在 `toChain` 上托管 `pay` 瞬时转账以外的任何东西。

## 4. 原理

- **报价由 `solver` 而非清单签名者签署。** `fromChain` 上的托管无法验证根植于 chainId 56 的 TAP-20 委托。Solver 在 `fromChain` 上控制的普通密钥处处可验证；TAP-21 信封仍将报价与服务身份绑定，用于发现与争议。
- **经 `toChain` 上的托管 `pay`。** 记录 `paid[quoteId]` 使"转账是否完成"变成一次 `eth_call`，正是 TAP-23 所见证的对象。读取原始转账日志需要 TAP-23 尚未定义的回执轮廓。
- **用户选见证者，Solver 以不付款否决。** 双方都必须接受见证者集合，而无需协议注册表。Solver 因坏集合承担的唯一风险是失去一次机会，因为它在付款前检查。
- **Solver 自带流动性。** UniswapX、Across、CoW 已证明意图加 Solver 的流程能承载真实流量；缺的是场所中立的身份与支付层，这正是 TapeAPI 提供的。

## 5. 向后兼容

增加一个方法描述符字段与一个合约接口。不向 `SPEC.md` 添加任何内容，不改变名称语法 `<#ID>.<processor>.tape`，不改变任何 §15.1 不变量。TAP-22 凭证不变；`quote` 与 `read` 调用是普通的 TAP-21 调用。

## 6. 测试向量

| 项目 | 值 |
|---|---|
| `QUOTE_TYPEHASH` | `0xe7c18a58c429974068166f7c27b8ba2a9a13177c83aeb69cdcac7a4bc7592d59` |
| `keccak256("IntentEscrow")` | `0x2043479336d59fcf0f30222e9c9f674b6a85c2fa5b5033d0c47e20469de7f0ba` |
| 报价摘要与签名算例 | Final 前 TODO |
| IntentEscrow 地址（CREATE2） | TODO（未部署） |
## 7. 参考实现

- `IntentEscrow` 与完整的 Solver 参考实现为 v0.4 交付项（`docs/CROSSCHAIN.md` §5），目前尚不存在（2026-09-27）。
- `examples/defi-rfq-solver` 是一个只构造并签署报价的 Solver 示例：`quote.mjs` 含类型字符串、`QUOTE_TYPEHASH` 与域，启动时对照 §6 自检。它不锁定也不释放任何资产。
- SDK 目前没有报价代码；报价的构造与验证将与 TAP-22 凭证代码一起置于 `sdk/`。

## 8. 安全考量

- **Solver 不履约。** 以 `expires + REFUND_DELAY` 为界；用户资金的风险不超过该延迟。
- **见证者合谋。** 若 `threshold` 个见证者说谎，`fulfil` 会把资金释放给未付款的 Solver。用户 MUST 按 TAP-23 §3.5 选择独立的见证者，大额时 SHOULD 采用 `threshold ≥ 3`。Solver 面临镜像风险（见证者拒绝见证真实付款），并通过在 `pay` 前审查集合来缓解。
- **报价重放。** 域中的 `chainId` 与 `verifyingContract`，加上一次性的 `quoteId`，防止跨链、跨托管、跨意图复用。
- **抢跑 `pay`。** 第三方向 `recipient` 付款不会在 Solver 地址下产生 `paid[quoteId]`，因此无法劫持锁定资产。`fulfil` MUST 将记录哈希中的 `msg.sender` 与 `q.solver` 核对。
- **`toChain` 重组。** 见证者 SHOULD 在已最终确认的区块读取；`fulfil` SHOULD 拒绝 `blockNumber` 浅于每链最终性深度的见证。
- **代币行为。** 转账收费或弹性供应代币破坏 `amountIn`/`amountOut` 的相等；部署 SHOULD 使用代币白名单或注明排除。

## 9. 版权

Copyright and related rights waived via CC0-1.0.
