| TAP | 23 |
|---|---|
| Title | TapeAPI: Attested Read |
| Author | Bruce (@BruceLanLan) |
| Status | Draft |
| Implementation | Implemented, not hosted (2026-09-27): the SDK's `callQuorum` applies §3.4 (including `ATTEST_DISAGREE`), and `examples/chain-attested-read` is a provider, but no live service offers an `attestedRead` method. No third-party audit. Staking and slashing remain out of scope. |
| Type | Standards |
| Created | 2026-09-20 |
| Requires | TAP-20, TAP-21 |
| License | CC0-1.0 |

# TAP-23: TapeAPI: Attested Read

> English is authoritative. 中文译文见下半部分，章节编号一一对应。

> **Placeholder number.** TAP-23 is a placeholder number proposed in [TapeKit issue #8](https://github.com/TapeOutProtocol/TapeKit/issues/8). TapeKit has no numbered-proposal process yet (changes to TapeOut itself follow TapeKit `SPEC.md` §15), so the maintainers may assign another number or move this document to another process; see [TAP-1](TAP-1.md).

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in RFC 2119.

## 1. Abstract

An Attested Read is a TapeAPI method that returns the result of a read-only call on some chain together with the block the result was taken from, signed under TAP-21 by the provider's service identity. This TAP defines the method profile, the response fields `{ chainId, blockNumber, blockHash, result }`, and the client-side quorum rule: a client MUST obtain byte-identical answers from at least two independent providers and MUST reject on any disagreement. No bridge, light client, or oracle committee is introduced. Staking and slashing of providers are explicitly out of scope for this version.

## 2. Motivation

An application on BNB Smart Chain frequently needs a fact from another chain: a token balance on Ethereum, an NFT holder on Base, whether a transaction has been confirmed. The existing answers are an oracle committee or a light-client bridge, both heavy to deploy and both introducing a new trust set. TapeAPI already gives any circuit holder a signed, attributable, payable method. Making the "read another chain" method a standard profile lets any number of independent operators, including the chains themselves, offer it, and lets clients combine them under the same rule the TapeOut kernel already uses for RPC nodes: at least two independent sources agree, never a majority vote.

## 3. Specification

### 3.1 Method Profile

A service offers Attested Read by listing a method whose descriptor (TAP-20 §3.3) carries an `attestedRead` object:

```json
{ "name": "read", "priceBEM": "0.0002",
  "params": { "chainId": "number", "call": "object", "block": "string|number" },
  "returns": { "chainId": "number", "blockNumber": "number", "blockHash": "bytes32", "result": "bytes" },
  "attestedRead": { "kind": "eth_call", "chains": [1, 8453, 56] } }
```

- `attestedRead.kind` MUST be `"eth_call"` in this version. Other kinds (non-EVM chains, log queries, receipts) MAY be defined by future TAPs and MUST use a different `kind` string.
- `attestedRead.chains` MUST be a non-empty array of `uint64` chain IDs the provider serves. A request for a chain not listed MUST be answered with `METHOD_NOT_FOUND`.
- The method name is not fixed; `read` is RECOMMENDED. Clients discover Attested Read services by the presence of `attestedRead`, not by name.

### 3.2 Request

`params` MUST be:

| Field | Type | Req. | Constraint |
|---|---|---|---|
| `chainId` | number | MUST | A value in `attestedRead.chains`. |
| `call.to` | address | MUST | Target contract. |
| `call.data` | hex | MUST | Calldata, `0x`-prefixed, even length. |
| `block` | number or string | MAY | Block number, or one of `"latest"`, `"safe"`, `"finalized"`. Default `"finalized"`. |

The provider MUST execute the equivalent of `eth_call(call, block)` against the named chain and MUST NOT execute it against any other chain. The provider SHOULD serve numeric `block` values at least as old as the chain's finality window; it MAY refuse with `INTERNAL` if the block is not available.

**Block resolution and evaluation (normative).**

1. When `block` is omitted the provider MUST resolve it as `"finalized"`. If its upstream does not support that tag it MAY fall back to `latest − N` for a configured `N` no smaller than the chain's typical reorg depth; either way the resolved `blockNumber` and `blockHash` MUST be returned (§3.3) so that a client can re-request the same block from other providers.
2. The provider MUST first obtain agreement of at least two of its upstream nodes on the hash of the resolved block, and MUST then evaluate the call **at that hash**, i.e. with the EIP-1898 block parameter `{ "blockHash": <blockHash>, "requireCanonical": true }`. Evaluating by number alone is not sufficient: between the hash check and the call a node may have reorganised, and the signed `result` would then not belong to the attested `blockHash`.
3. Only when an upstream node rejects the EIP-1898 block object (not when the call reverts) MAY the provider fall back to evaluating by `blockNumber`, and it MUST then set `blockRef` to `"number"` in the result. Clients MAY treat such results as weaker evidence and MAY reject them.

### 3.3 Response

The TAP-21 envelope's `result` object MUST contain exactly the following fields, all covered by the TAP-21 signature:

| Field | Type | Constraint |
|---|---|---|
| `chainId` | number | MUST echo the request. |
| `blockNumber` | number | The block the call was executed at. |
| `blockHash` | bytes32 hex | The hash of that block, as reported by the provider's upstream. |
| `stateRoot` | bytes32 hex | OPTIONAL. The state root of that block. |
| `blockRef` | string | OPTIONAL. `"hash"` (default when absent) when the call was evaluated at `blockHash` per §3.2; `"number"` when it was evaluated by `blockNumber` only. MUST be present and equal to `"number"` in the latter case. |
| `result` | hex | The raw return data of the call, `0x`-prefixed. A reverting call MUST be answered as a TAP-21 error with code `INTERNAL`, `message` `"execution reverted"`, and the revert bytes in `error.data.revert` (`0x`-hex), not as an empty `result`. Revert data is chain state, not an upstream detail (TAP-21 §3.2), and is covered by the signature. |

Providers MUST NOT add other fields to `result`. The TAP-21 `block` field, if present, refers to the provider's home chain (chainId 56) and is unrelated to `blockNumber` above.

### 3.4 Quorum Rule

A client that acts on an Attested Read MUST apply the following rule, which is the same rule the TapeOut kernel applies to RPC nodes (SPEC §15.1, TAP-20 §3.2):

1. Select `N ≥ 2` providers that are independent (§3.5) and all list the target `chainId`.
2. Send the identical request (same `chainId`, `call`, and an explicit numeric `block`) to every selected provider. Clients MUST NOT rely on tag-based blocks (`"finalized"`, `"latest"`) for the quorum round: two providers evaluate tags at different instants and the answers legitimately differ. The client obtains the number from a first request to any one provider (whose response carries `blockNumber`/`blockHash` per §3.2) or from its own node, and re-sends it to all.
3. Verify every envelope under TAP-21. Discard envelopes that fail verification or are not received; these are transport failures, not disagreement. Only a verified envelope with `ok: true` is an answer that steps 4 and 5 compare. A verified error envelope, the revert of §3.3 included, is not compared: like a transport failure it lowers the number of verified answers and is reported, but it is neither agreement nor disagreement, so that one provider refusing (for example a block it does not have, §3.2) cannot veto the others.
4. Two envelopes **agree** iff their `chainId`, `blockNumber`, `blockHash`, and `result` are byte-identical (`stateRoot` is compared only when present in both).
5. Accept iff at least two verified envelopes were received and **all** verified envelopes agree. If any two verified envelopes disagree, the client MUST reject with `ATTEST_DISAGREE`, regardless of how many agree with each other. A client MUST NOT resolve disagreement by majority, by reputation, or by retrying only the minority.
   A client MAY offer an explicit, off-by-default mode in which a single group reaching the quorum size is accepted while dissenters are reported (the reference SDK calls it `onDissent: 'quorum'`). That mode trades the failure mode "deny" for "forgeable by `quorum` colluding providers" and MUST NOT be the default; it is only defensible when the caller chose the provider set itself and accepts that weaker guarantee. Even in that mode, two distinct groups both reaching quorum MUST be rejected as ambiguous, never resolved by size.

The reference SDK reports this rejection as `ATTEST_DISAGREE`, and uses `QUORUM_FAILED` for generic (non-attested) multi-provider calls and for too few verifiable answers (TAP-21 §3.4). It refuses `quorum < 2` unless the caller passes an explicit `allowSingleProvider` opt-out, refuses a tolerance (`compare`) on an attested read (§8), and requires a numeric `block` in the quorum round (step 2).

The provider chosen for the first request cannot bias the result: every other provider independently verifies the hash of that block against its own upstream and evaluates at that hash, so a wrong or non-canonical block yields disagreement or an error, never a wrong agreed answer. Clients SHOULD nevertheless prefer a block inside the finality window.

### 3.5 Independence

Two providers are independent for the purpose of §3.4 iff both hold:

- **Different holders.** `IERC721(circuits).ownerOf(tokenId)` (TAP-20 §3.6 step 4) differs between the two services at the time of the request.
- **Different origins.** No origin (scheme, host and port) appears in the `endpoints.live` of both services. Every listed URL counts, not only the one a client happens to use: endpoint failover (TAP-21) may move a call to any of them.

Clients MUST NOT count two services that share a holder or an origin as two sources. Clients enforce holder independence using the holder verified at resolution (TAP-20 §3.6, `verified.holder`) and origin independence across every URL in `endpoints.live`, not only the URL a call happens to use. Clients SHOULD additionally prefer providers that are known to use different upstream nodes; this cannot be verified on-chain and is informative only.

### 3.6 Economic Security (Future Work)

This version relies on multi-provider agreement only. A future TAP MAY extend the TAP-22 escrow with a provider `stake()` and a fraud proof in which a signed Attested Read is shown, with a Merkle proof against the block identified by its own `blockHash`, to be false, and the stake is slashed to the prover. Nothing in this TAP depends on that extension, and clients MUST NOT assume any provider is staked.

## 4. Rationale

- **Block-anchored, not time-anchored.** `blockNumber` and `blockHash` make an answer a statement about a specific state rather than "what my node said at some moment", which is what makes two providers comparable and what a future fraud proof would be checked against.
- **Reject on disagreement.** Majority voting turns three providers into a committee whose 2-of-3 threshold is the new attack surface. Requiring unanimity among ≥2 independent sources keeps the failure mode a denial of service, never a wrong answer, and is the rule ecosystem reviewers already accept for RPC nodes.
- **Independence by holder and origin.** Both are checkable by the client with data it already has after TAP-20 resolution. Weaker notions (different labels, different signers) are trivially satisfied by one operator.
- **No new trust set.** Any circuit holder may become a provider; the client, not the protocol, chooses whom to combine.

## 5. Backwards Compatibility

This TAP adds a method-descriptor field and a response profile. It adds nothing to `SPEC.md`, does not alter the name grammar `<#ID>.<processor>.tape`, and does not alter any §15.1 invariant. TAP-20 clients that do not know `attestedRead` ignore it as an unknown field.

## 6. Test Vectors

| Item | Value |
|---|---|
| Example request `params` | `{ "chainId": 1, "call": { "to": "0xdAC17F958D2ee523a2206206994597C13D831ec7", "data": "0x18160ddd" }, "block": 20000000 }` |
| Example `result` shape | `{ "chainId": 1, "blockNumber": 20000000, "blockHash": "0x…", "result": "0x…" }` |
| Two-provider agreeing envelopes with signatures | TODO before Final |
| Mainnet (chainId 56) manifest of a live Attested Read service | TODO before Final |

## 7. Reference Implementation

- SDK: `api.callQuorum(services, method, params, { quorum, compare, onDissent, allowSingleProvider })` in `sdk/src/index.js`, which applies §3.4 (and `ATTEST_DISAGREE`) whenever a selected method carries `attestedRead` (plan: `docs/CROSSCHAIN.md` §5).
- Example: `examples/chain-attested-read`, a provider reading Ethereum and Base (default `finalized`, EIP-1898 evaluation by `blockHash`, `blockRef` reported).
- No live service offers an `attestedRead` method yet, and neither has a third-party audit (2026-09-27). The public service `api.tapeapi.fun` pins each of its BSC answers to a block (`blockPinned`) so that `callQuorum` can compare providers, but its methods are not TAP-23 methods.

## 8. Security Considerations
- **Trust tier, stated plainly.** An attested read is a *Tier 1* guarantee: "the providers the client itself
  chose all said the same thing." It is not a Tier 2 guarantee, because no provider is staked and nothing is
  slashed; a second identity costs on the order of 0.01 BNB, so economic independence between two providers
  cannot be assumed from the protocol alone. The guarantee is therefore exactly as strong as the client's
  provider selection and no stronger. Clients MUST NOT treat an attested read as sufficient evidence to
  release funds or to feed a lending protocol's primary price path; those uses require Tier 2, which this
  version does not provide. This is a limitation of the current protocol, not a property a client can
  configure around.

- **Byte-identical agreement is required for attested reads, and is the default.** An attested read returns
  what a chain actually said at a pinned block, so two honest providers MUST produce the same bytes; any
  difference is a disagreement and MUST be rejected. Clients MAY opt in to a numeric tolerance
  (`compare: { relTolBps, paths }`) for values that are *derived* rather than read, such as a price
  aggregated from several sources, where two honest providers legitimately differ. A tolerance MUST NOT be
  applied to an attested read, and even when it is applied every field outside `paths` MUST still match
  byte-for-byte, including the pinned block. Tolerance widens what counts as agreement; it never replaces it,
  and it is never a majority vote.


- **Single provider is a single signer.** A client that reads from one provider has exactly the assurance of that provider's key. The quorum rule in §3.4 is the only defence this TAP offers and is therefore stated as MUST.
- **Upstream compromise.** A provider is only as good as its upstream node. Providers SHOULD themselves apply multi-node agreement to their upstream reads.
- **Reorgs.** A `blockHash` on a non-final block may be orphaned. Clients SHOULD request blocks inside the target chain's finality window and MAY re-read later. Because the provider evaluates at the hash (§3.2), a result can never be silently taken from a different fork than the one it names; the worst case is an error or, with `blockRef: "number"`, an explicitly weaker statement.
- **Sybil providers.** One operator may hold many circuits under many addresses. §3.5 raises the cost (distinct holders, distinct origins) but cannot eliminate it; clients SHOULD choose providers by out-of-band reputation and diversity.
- **Chain confusion.** `chainId` is inside the signed `result`, so an answer for one chain cannot be replayed as an answer for another.
- **Denial of service.** Rejecting on disagreement means one malicious provider among the selected set can block a read. Clients SHOULD keep a larger candidate set and re-run with a different independent subset; they MUST NOT downgrade to accepting a subset that agrees while ignoring a verified dissent from the same run.

## 9. Copyright

Copyright and related rights waived via CC0-1.0.

---

# TAP-23：TapeAPI：见证读取（中文译文）

> 英文为权威文本，本译文与英文章节一一对应。

> **占位编号。** TAP-23 是在 [TapeKit issue #8](https://github.com/TapeOutProtocol/TapeKit/issues/8) 中提议的占位编号。TapeKit 目前还没有编号提案流程（对 TapeOut 本身的修改遵循 TapeKit `SPEC.md` §15），因此维护者可能另行分配编号，或把本文档移入其它流程；见 [TAP-1](TAP-1.md)。

> **实现状态（2026-09-27）：** 已实现，未托管：SDK 的 `callQuorum` 执行 §3.4（包括 `ATTEST_DISAGREE`），`examples/chain-attested-read` 是一个提供者示例，但没有任何运行中的服务提供 `attestedRead` 方法。未经第三方审计。质押与罚没仍不在范围内。

本文档中的关键词 "MUST"（必须）、"MUST NOT"（禁止）、"REQUIRED"（必需）、"SHALL"、"SHOULD"（应当）、"SHOULD NOT"（不应）、"RECOMMENDED"（推荐）、"MAY"（可以）、"OPTIONAL"（可选）按 RFC 2119 解释。

## 1. 摘要

见证读取（Attested Read）是一种 TapeAPI 方法：返回某条链上一次只读调用的结果，连同结果所取自的区块，由提供者的服务身份按 TAP-21 签名。本 TAP 定义方法轮廓、响应字段 `{ chainId, blockNumber, blockHash, result }`，以及客户端的法定人数规则：客户端 MUST 从至少两个独立提供者获得逐字节一致的答案，且任何不一致 MUST 拒绝。不引入桥、轻客户端或预言机委员会。提供者的质押与罚没明确不在本版本范围内。

## 2. 动机

BNB Smart Chain 上的应用经常需要另一条链上的事实：Ethereum 上的代币余额、Base 上的 NFT 持有者、某笔交易是否已确认。现有答案是预言机委员会或轻客户端桥，二者部署都重，且都引入新的信任集合。TapeAPI 已经让任何电路持有者拥有可签名、可归属、可计费的方法。将"读另一条链"做成标准轮廓，使任意数量的独立运营者（包括各公链自己）都能提供它，并让客户端按 TapeOut 内核对 RPC 节点已经采用的同一规则组合它们：至少两个独立来源一致，永不多数决。

## 3. 规范

### 3.1 方法轮廓

服务通过列出一个描述符（TAP-20 §3.3）带有 `attestedRead` 对象的方法来提供见证读取：

```json
{ "name": "read", "priceBEM": "0.0002",
  "params": { "chainId": "number", "call": "object", "block": "string|number" },
  "returns": { "chainId": "number", "blockNumber": "number", "blockHash": "bytes32", "result": "bytes" },
  "attestedRead": { "kind": "eth_call", "chains": [1, 8453, 56] } }
```

- 本版本中 `attestedRead.kind` MUST 为 `"eth_call"`。其他种类（非 EVM 链、日志查询、回执）MAY 由未来 TAP 定义，且 MUST 使用不同的 `kind` 字符串。
- `attestedRead.chains` MUST 为非空的 `uint64` 链 ID 数组，列出提供者服务的链。对未列出链的请求 MUST 以 `METHOD_NOT_FOUND` 回应。
- 方法名不固定；RECOMMENDED 使用 `read`。客户端以 `attestedRead` 的存在而非名称来发现见证读取服务。

### 3.2 请求

`params` MUST 为：

| 字段 | 类型 | 要求 | 约束 |
|---|---|---|---|
| `chainId` | number | MUST | `attestedRead.chains` 中的一个值。 |
| `call.to` | address | MUST | 目标合约。 |
| `call.data` | hex | MUST | 调用数据，`0x` 前缀，偶数长度。 |
| `block` | number 或 string | MAY | 区块号，或 `"latest"`、`"safe"`、`"finalized"` 之一。默认 `"finalized"`。 |

提供者 MUST 对指定链执行等价于 `eth_call(call, block)` 的操作，且 MUST NOT 对任何其他链执行。提供者 SHOULD 服务不晚于该链最终性窗口的数字 `block`；若区块不可用，MAY 以 `INTERNAL` 拒绝。

**区块解析与求值（规范性）。**

1. `block` 省略时，提供者 MUST 按 `"finalized"` 解析。若其上游不支持该标签，MAY 退到 `latest − N`（`N` 为配置值，不小于该链典型的重组深度）；无论哪种，解析出的 `blockNumber` 与 `blockHash` MUST 返回（§3.3），以便客户端向其他提供者请求同一区块。
2. 提供者 MUST 先取得至少两个上游节点对该区块哈希的一致，然后 MUST **在该哈希上**求值，即使用 EIP-1898 区块参数 `{ "blockHash": <blockHash>, "requireCanonical": true }`。仅按区块号求值是不够的：在哈希检查与调用之间节点可能已重组，签名的 `result` 就不属于所声明的 `blockHash`。
3. 只有当上游节点拒绝 EIP-1898 区块对象时（而非调用回滚时），提供者 MAY 退回按 `blockNumber` 求值，且此时 MUST 在结果中把 `blockRef` 置为 `"number"`。客户端 MAY 将此类结果视为更弱的证据，MAY 拒绝。

### 3.3 响应

TAP-21 信封的 `result` 对象 MUST 恰好包含以下字段，全部被 TAP-21 签名覆盖：

| 字段 | 类型 | 约束 |
|---|---|---|
| `chainId` | number | MUST 回显请求。 |
| `blockNumber` | number | 调用执行所在的区块。 |
| `blockHash` | bytes32 hex | 该区块的哈希，以提供者上游报告为准。 |
| `stateRoot` | bytes32 hex | OPTIONAL。该区块的状态根。 |
| `blockRef` | string | OPTIONAL。按 §3.2 在 `blockHash` 上求值时为 `"hash"`（缺省即此）；仅按 `blockNumber` 求值时为 `"number"`，后一种情况 MUST 存在且等于 `"number"`。 |
| `result` | hex | 调用的原始返回数据，`0x` 前缀。回滚的调用 MUST 以 TAP-21 错误回应，错误码 `INTERNAL`，`message` 为 `"execution reverted"`，回滚字节（`0x` 十六进制）置于 `error.data.revert`，而非空 `result`。回滚数据是链上状态而非上游细节（TAP-21 §3.2），在签名范围内。 |

提供者 MUST NOT 向 `result` 添加其他字段。TAP-21 的 `block` 字段（如存在）指提供者的本链（chainId 56），与上述 `blockNumber` 无关。

### 3.4 法定人数规则

依据见证读取采取行动的客户端 MUST 应用以下规则，它与 TapeOut 内核对 RPC 节点的规则相同（SPEC §15.1，TAP-20 §3.2）：

1. 选择 `N ≥ 2` 个相互独立（§3.5）且都列出目标 `chainId` 的提供者。
2. 向每个选定提供者发送完全相同的请求（相同 `chainId`、`call`，以及显式的数字 `block`）。法定人数这一轮客户端 MUST NOT 依赖标签区块（`"finalized"`、`"latest"`）：两个提供者在不同时刻解析标签，答案会合法地不同。客户端先向任一提供者请求一次（其响应按 §3.2 携带 `blockNumber`/`blockHash`）或从自己的节点取得区块号，再发给所有提供者。
3. 按 TAP-21 验证每个信封。丢弃验证失败或未收到的信封；这些是传输失败，不是不一致。只有 `ok: true` 的已验证信封才是步骤 4 与 5 比较的回答。已验证的错误信封（包括 §3.3 的回滚）不参与比较：它与传输失败一样减少已验证回答的数量并被报告，但既不算一致也不算不一致，使一个拒绝作答的提供者（例如没有该区块，§3.2）无法否决其他提供者。
4. 两个信封**一致**当且仅当其 `chainId`、`blockNumber`、`blockHash`、`result` 逐字节相同（`stateRoot` 仅在两者都存在时比较）。
5. 当且仅当收到至少两个已验证信封且**所有**已验证信封一致时接受。若任意两个已验证信封不一致，客户端 MUST 以 `ATTEST_DISAGREE` 拒绝，无论有多少个彼此一致。客户端 MUST NOT 以多数决、声誉或仅重试少数方来解决不一致。
   客户端 MAY 提供一个默认关闭的显式模式：接受唯一达到法定人数的一组，并报告持异议者（参考 SDK 称其为 `onDissent: 'quorum'`）。该模式把失败模式从"拒绝"换成"可被 `quorum` 个合谋提供者伪造"，MUST NOT 作为默认；仅当调用方自行挑选提供者集合并接受这一更弱保证时才站得住脚。即使在该模式下，两组都达到法定人数时 MUST 以歧义拒绝，绝不以规模决胜。

参考 SDK 将这一拒绝报告为 `ATTEST_DISAGREE`，对一般（非见证）的多提供者调用以及可验证答案过少的情况使用 `QUORUM_FAILED`（TAP-21 §3.4）。除非调用方显式传入 `allowSingleProvider` 退出选项，否则它拒绝 `quorum < 2`；它拒绝对见证读取使用容差（`compare`）（§8），并要求法定人数这一轮使用数字 `block`（步骤 2）。

被选来做第一次请求的提供者无法左右结果：其他每个提供者都独立地用自己的上游核对该区块的哈希并在该哈希上求值，因此错误或非规范的区块只会导致不一致或错误，永远不会产生错误的一致答案。客户端仍 SHOULD 优先选择最终性窗口内的区块。

### 3.5 独立性

就 §3.4 而言，两个提供者独立当且仅当同时满足：

- **不同持有者。** 请求时刻两个服务的 `IERC721(circuits).ownerOf(tokenId)`（TAP-20 §3.6 步骤 4）不同。
- **不同源。** 两个服务的 `endpoints.live` 中没有任何相同的源（scheme、host、port）。列出的每个 URL 都算，而不只是客户端碰巧使用的那个：端点故障切换（TAP-21）可能把调用转到其中任何一个。

客户端 MUST NOT 将共享持有者或共享源的两个服务计为两个来源。客户端以解析时验证过的持有者（TAP-20 §3.6，`verified.holder`）判定持有者独立性，并在 `endpoints.live` 的全部 URL 之间（而不仅是某次调用恰好使用的那个）判定源独立性。客户端 SHOULD 额外优先选择已知使用不同上游节点的提供者；这无法在链上验证，仅供参考。

### 3.6 经济安全（未来工作）

本版本仅依赖多提供者一致。未来 TAP MAY 扩展 TAP-22 托管，增加提供者 `stake()` 与欺诈证明：出示一份已签名的见证读取，并以其自身 `blockHash` 所标识区块的 Merkle 证明证明其为假，质押罚没给举证人。本 TAP 不依赖该扩展，客户端 MUST NOT 假定任何提供者已质押。

## 4. 原理

- **锚定区块而非时间。** `blockNumber` 与 `blockHash` 使答案成为对特定状态的陈述，而非"我的节点某时刻说了什么"，这正是两个提供者可比较的前提，也是未来欺诈证明的核验对象。
- **不一致即拒绝。** 多数投票把三个提供者变成一个 2/3 门槛的委员会，门槛本身成为新的攻击面。要求 ≥2 个独立来源全体一致，使失败模式只能是拒绝服务而永远不是错误答案，也正是生态评审者对 RPC 节点已经接受的规则。
- **以持有者与源定义独立。** 二者都可由客户端用 TAP-20 解析后已有的数据检查。更弱的定义（不同标签、不同签名者）一个运营者即可轻易满足。
- **不引入新信任集合。** 任何电路持有者都可成为提供者；由客户端而非协议决定组合谁。

## 5. 向后兼容

本 TAP 增加一个方法描述符字段与一个响应轮廓。不向 `SPEC.md` 添加任何内容，不改变名称语法 `<#ID>.<processor>.tape`，不改变任何 §15.1 不变量。不认识 `attestedRead` 的 TAP-20 客户端将其作为未知字段忽略。

## 6. 测试向量

| 项目 | 值 |
|---|---|
| 示例请求 `params` | `{ "chainId": 1, "call": { "to": "0xdAC17F958D2ee523a2206206994597C13D831ec7", "data": "0x18160ddd" }, "block": 20000000 }` |
| 示例 `result` 形状 | `{ "chainId": 1, "blockNumber": 20000000, "blockHash": "0x…", "result": "0x…" }` |
| 两个提供者一致的带签名信封 | Final 前 TODO |
| 主网（chainId 56）上线见证读取服务的清单 | Final 前 TODO |

## 7. 参考实现

- SDK：`sdk/src/index.js` 中的 `api.callQuorum(services, method, params, { quorum, compare, onDissent, allowSingleProvider })`，所选方法带 `attestedRead` 时执行 §3.4（及 `ATTEST_DISAGREE`）（计划见 `docs/CROSSCHAIN.md` §5）。
- 示例：`examples/chain-attested-read`，读取 Ethereum 与 Base 的提供者（默认 `finalized`，按 EIP-1898 在 `blockHash` 上求值，报告 `blockRef`）。
- 目前没有任何运行中的服务提供 `attestedRead` 方法，二者均未经第三方审计（2026-09-27）。公共服务 `api.tapeapi.fun` 把每个 BSC 回答钉在一个区块上（`blockPinned`），以便 `callQuorum` 比较不同提供者，但它的方法不是 TAP-23 方法。

## 8. 安全考量
- **信任等级，直说。** 证明式读取是**一级**保证："调用方自己挑选的那几个提供者说了同样的话。"
  它不是二级保证，因为没有任何提供者被质押、也没有任何罚没；一个新身份的成本约为 0.01 BNB，
  因此两个提供者之间的经济独立性无法仅凭协议推定。该保证的强度**恰好等于调用方挑选提供者的强度**，
  不会更强。客户端 MUST NOT 把证明式读取当作释放资金、或作为借贷协议主价格路径的充分依据；
  那些用途需要二级保证，而本版本不提供。这是当前协议的局限，不是客户端可以配置绕开的属性。

- **证明式读取必须逐字节一致，且为默认。** 证明式读取返回的是某条链在钉定区块上的真实状态，两个诚实的提供者
  MUST 给出相同字节；任何差异都是分歧，MUST 拒绝。对于**推导**而非读取得到的数值（例如由多个来源聚合出的价格），
  两个诚实提供者本就会有差异，客户端 MAY 选用数值容差（`compare: { relTolBps, paths }`）。容差 MUST NOT
  用于证明式读取；即使启用，`paths` 之外的每个字段仍 MUST 逐字节相同，包括钉定的区块。容差只是放宽"何为一致"，
  绝不取代一致，也绝不是多数投票。


- **单个提供者只是单个签名者。** 只从一个提供者读取的客户端所获得的保证恰为该提供者密钥的保证。§3.4 的法定人数规则是本 TAP 提供的唯一防线，因此以 MUST 表述。
- **上游被攻破。** 提供者的可靠性不超过其上游节点。提供者 SHOULD 对自身的上游读取同样应用多节点一致。
- **重组。** 非最终区块的 `blockHash` 可能被孤立。客户端 SHOULD 请求目标链最终性窗口内的区块，并 MAY 稍后重读。由于提供者在哈希上求值（§3.2），结果永远不会悄悄取自与其声明不同的分叉；最坏情况是一个错误，或带 `blockRef: "number"` 的、明确更弱的陈述。
- **女巫提供者。** 一个运营者可能以多个地址持有多个电路。§3.5 提高了成本（不同持有者、不同源）但无法消除；客户端 SHOULD 依据链外声誉与多样性选择提供者。
- **链混淆。** `chainId` 在被签名的 `result` 内，因此一条链的答案不能被重放为另一条链的答案。
- **拒绝服务。** 不一致即拒绝意味着选定集合中的一个恶意提供者即可阻断一次读取。客户端 SHOULD 维护更大的候选集合并以另一独立子集重跑；MUST NOT 退化为接受一致的子集而忽略同一轮中已验证的异议。

## 9. 版权

Copyright and related rights waived via CC0-1.0.
