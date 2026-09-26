| TAP | 25 |
|---|---|
| Title | TapeAPI: Circuit-Verified Methods |
| Author | Bruce (@BruceLanLan) |
| Status | Draft |
| Type | Standards |
| Created | 2026-09-20 |
| Requires | TAP-20, TAP-21 |
| License | CC0-1.0 |

# TAP-25: TapeAPI: Circuit-Verified Methods

> English is authoritative. 中文译文见下半部分，章节编号一一对应。

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in RFC 2119.

## 1. Abstract

A Circuit-Verified Method is a TapeAPI method whose input/output relation is defined by a taped-out TapeOut circuit. The manifest names the circuit in a `verifier` object; the provider computes off-chain and signs under TAP-21; anyone may encode `(input, output)` as a bit vector and re-evaluate it on-chain through the circuit contract's `eval()`. A mismatch between the circuit's output and the signed output is self-evident proof of misbehaviour, without a zero-knowledge proving system. This TAP defines the `verifier` object and sketches the dispute flow; the bit encoding is left TODO until the exact `eval()` ABI is confirmed.

## 2. Motivation

Every other API standard stops at "the provider signed it". TapeOut is the one ecosystem in which a small piece of logic already lives on-chain as an evaluable circuit, and in which the community produces such circuits daily as proof-of-design tasks (adders, multipliers, S-boxes). Binding a method to a circuit gives those artefacts a direct commercial use and gives consumers a verification path that costs nothing to publish and only gas to dispute.

## 3. Specification

### 3.1 The `verifier` Object

A method descriptor (TAP-20 §3.3) MAY carry:

```json
{ "name": "settleRound", "priceBEM": "0.001",
  "params": { "state": "bytes", "moves": "bytes" }, "returns": { "next": "bytes" },
  "verifier": { "circuits": "0x…", "tokenId": "1337", "encoding": "tapi-bits-v1", "maxGas": 6000000 } }
```

| Field | Type | Req. | Constraint |
|---|---|---|---|
| `circuits` | address | MUST | ERC-721 processor contract on chainId 56. |
| `tokenId` | string | MUST | Decimal; the circuit token. MAY be, but need not be, the service's own circuit. |
| `encoding` | string | MUST | Exactly `"tapi-bits-v1"` in this version. Clients MUST treat other values as an unverifiable method. |
| `maxGas` | number | MUST | Upper bound the provider asserts for one `eval()` of this circuit. Informative for the client; a dispute contract MAY use it as the gas budget. |

The presence of `verifier` asserts: for every accepted call, `decode(eval(encodeIn(params)))` equals the signed `result`. A provider that lists `verifier` and signs a `result` that the circuit would not produce has misbehaved.

### 3.2 Circuit Contract Surface

The circuit contract identified by `(circuits, tokenId)` is expected to expose (informative, from community measurements; the normative ABI is TODO):

- `netlist(tokenId)` – the gate list, sufficient for off-chain simulation.
- `eval(tokenId, bits)` – evaluates the circuit on an input bit vector and returns the output bit vector.
- Cost is approximately 2 468 gas per gate. Under a 12 M gas transaction cap this bounds a single on-chain evaluation to roughly 4 800 gates. These figures are informative and MUST NOT be relied on normatively.

### 3.3 Encoding `tapi-bits-v1` (TODO)

The mapping from JSON `params`/`result` to input and output bit vectors is deferred until the exact `eval()` ABI (argument packing, bit order, output length) is confirmed against the deployed processor contracts. Until then:

- `encoding` MUST be `"tapi-bits-v1"` and clients MUST NOT attempt on-chain disputes.
- Clients MAY perform local verification by fetching `netlist()` and simulating; a local mismatch is a reason to stop trusting the provider but is not yet a slashing event.

The final encoding MUST be deterministic, MUST cover every field in `params` and `result` in the order they appear in the descriptor, and MUST be reproducible by a contract from ABI-encoded arguments alone, without JSON parsing.

### 3.4 Dispute Flow (sketch)

A future extension of the TAP-22 escrow, or a dedicated `Dispute` contract, provides:

```
dispute(Envelope e, bytes inputBits, bytes claimedOutputBits) payable
  // Challenger posts a bond. Contract: (1) recomputes the TAP-21 digest from e and recovers the
  // signer; (2) resolves signer → container → holder via ServiceDirectory.verifyDelegation and
  // DeWebHub.accountOf on chainId 56; (3) checks inputBits/claimedOutputBits encode e.params /
  // e.result under tapi-bits-v1; (4) calls eval(verifier.tokenId, inputBits) with verifier.maxGas;
  // (5) if the output != claimedOutputBits, slashes part of the provider's stake to the challenger;
  //     otherwise forfeits the bond to the provider.
```

The dispute contract MUST NOT decide by anything other than the circuit's output. Because circuits live on chainId 56, disputes are settled on chainId 56 regardless of where the call was paid for. Staking is future work (see TAP-23 §3.6); until it exists, a losing dispute produces an on-chain event and nothing else.

### 3.5 Suitability

Suitable: game round settlement rules; lottery draws and randomness combination; hashes, checksums, and encoders; small state machines; binary neural network inference within the gate budget. Unsuitable: anything above the gate budget; large-model inference; methods whose output depends on data the circuit cannot receive as input (time, other-chain state, private databases). Providers MUST NOT list `verifier` on a method whose output depends on inputs not covered by the encoding.

## 4. Rationale

- **Re-execution, not proof.** A zk system needs a prover, a trusted or transparent setup, and a verifier contract per circuit. Re-evaluating the same gates on-chain needs none of that and costs gas only when someone disputes.
- **Circuit named in the manifest, not in the response.** The relation is a property of the method, fixed in the signed manifest, so a provider cannot switch circuits per call.
- **Encoding deferred.** Guessing the bit layout would produce a specification that no implementation can satisfy. The TODO is explicit and is the gate for v0.3 in `docs/CROSSCHAIN.md` §5.
- **Any circuit, not only the service's own.** A service may sell a method verified by a community circuit it does not own; the circuit holder's incentive is separate and out of scope.

## 5. Backwards Compatibility

Adds one OPTIONAL method-descriptor field. Adds nothing to `SPEC.md`, does not alter the name grammar `<#ID>.<processor number>.tape`, and does not alter any §15.1 invariant. Clients unaware of `verifier` ignore it.

## 6. Test Vectors

| Item | Value |
|---|---|
| Example `verifier` | `{ "circuits": "0x…", "tokenId": "1337", "encoding": "tapi-bits-v1", "maxGas": 6000000 }` |
| A PoD adder circuit: `(input, output)` pair, its bit vectors, and `eval()` gas | TODO (blocked on §3.3) |
| Mainnet (chainId 56) `eval()` call and result | TODO before Final |

## 7. Reference Implementation

- SDK local re-evaluation using a netlist simulator and an example service exposing a PoD adder as a verified method are v0.3 deliverables (`docs/CROSSCHAIN.md` §5).
- Dispute contract: v0.4, after audit. Nothing exists at the time of writing.

## 8. Security Considerations

- **False `verifier`.** A provider may name a circuit that does not compute the advertised function. Clients SHOULD simulate the netlist against a few known pairs before paying, and the dispute flow makes a wrong `verifier` as costly as a wrong answer once staking exists.
- **Gas griefing.** `maxGas` bounds the dispute cost; a dispute contract MUST refuse circuits whose evaluation exceeds the block gas budget rather than leave the challenger unable to prove.
- **Encoding ambiguity.** Two valid encodings of the same JSON would let a provider argue the challenger encoded wrongly. §3.3 therefore requires the encoding to be deterministic and reproducible from ABI data.
- **Circuit upgrade or transfer.** Circuits are immutable once taped out; transfer of the token changes its holder but not its netlist. `verifier` therefore binds a function, not a party.
- **Off-chain divergence.** Providers computing with a faster implementation than the circuit MUST ensure bit-exact equivalence, including overflow and edge cases; the circuit, not the fast path, is the definition.

## 9. Copyright

Copyright and related rights waived via CC0-1.0.

---

# TAP-25：TapeAPI：电路验证方法（中文译文）

> 英文为权威文本，本译文与英文章节一一对应。

本文档中的关键词 "MUST"（必须）、"MUST NOT"（禁止）、"REQUIRED"（必需）、"SHALL"、"SHOULD"（应当）、"SHOULD NOT"（不应）、"RECOMMENDED"（推荐）、"MAY"（可以）、"OPTIONAL"（可选）按 RFC 2119 解释。

## 1. 摘要

电路验证方法是一种 TapeAPI 方法，其输入/输出关系由一个已流片的 TapeOut 电路定义。清单在 `verifier` 对象中指明该电路；提供者在链下计算并按 TAP-21 签名；任何人都可以把 `(input, output)` 编码为比特向量，通过电路合约的 `eval()` 在链上重算。电路输出与签名输出不一致即为不言自明的作恶证据，无需零知识证明系统。本 TAP 定义 `verifier` 对象并勾勒争议流程；比特编码在确认 `eval()` 的精确 ABI 之前留为 TODO。

## 2. 动机

其他所有 API 标准都止步于"提供者签了名"。TapeOut 是唯一一个已经把小型逻辑以可求值电路形式放在链上、且社区每天以设计证明（PoD）任务产出此类电路（加法器、乘法器、S-box）的生态。把方法绑定到电路，给这些产物一个直接的商业用途，也给消费者一条发布零成本、只在争议时花 gas 的验证路径。

## 3. 规范

### 3.1 `verifier` 对象

方法描述符（TAP-20 §3.3）MAY 携带：

```json
{ "name": "settleRound", "priceBEM": "0.001",
  "params": { "state": "bytes", "moves": "bytes" }, "returns": { "next": "bytes" },
  "verifier": { "circuits": "0x…", "tokenId": "1337", "encoding": "tapi-bits-v1", "maxGas": 6000000 } }
```

| 字段 | 类型 | 要求 | 约束 |
|---|---|---|---|
| `circuits` | address | MUST | chainId 56 上的 ERC-721 处理器合约。 |
| `tokenId` | string | MUST | 十进制；电路代币。MAY 是、但不必是服务自身的电路。 |
| `encoding` | string | MUST | 本版本恰为 `"tapi-bits-v1"`。客户端 MUST 将其他值视为不可验证的方法。 |
| `maxGas` | number | MUST | 提供者声称的该电路单次 `eval()` 上限。对客户端仅供参考；争议合约 MAY 将其用作 gas 预算。 |

`verifier` 的存在断言：对每次被接受的调用，`decode(eval(encodeIn(params)))` 等于被签名的 `result`。列出 `verifier` 却签署了电路不会产生的 `result` 的提供者即为作恶。

### 3.2 电路合约表面

由 `(circuits, tokenId)` 标识的电路合约预期暴露（仅供参考，来自社区测量；规范性 ABI 为 TODO）：

- `netlist(tokenId)` —— 门列表，足以进行链下模拟。
- `eval(tokenId, bits)` —— 在输入比特向量上求值电路并返回输出比特向量。
- 成本约为每门 2 468 gas。在 1200 万 gas 的交易上限下，单次链上求值约限于 4 800 门。这些数字仅供参考，MUST NOT 作为规范性依据。

### 3.3 编码 `tapi-bits-v1`（TODO）

从 JSON `params`/`result` 到输入、输出比特向量的映射，推迟到 `eval()` 的精确 ABI（参数打包、比特序、输出长度）对照已部署的处理器合约确认之后。在此之前：

- `encoding` MUST 为 `"tapi-bits-v1"`，客户端 MUST NOT 尝试链上争议。
- 客户端 MAY 通过获取 `netlist()` 并模拟来做本地验证；本地不一致是停止信任该提供者的理由，但尚不构成罚没事件。

最终编码 MUST 确定性，MUST 按描述符中出现的顺序覆盖 `params` 与 `result` 的每个字段，且 MUST 可由合约仅从 ABI 编码的参数重现，无需 JSON 解析。

### 3.4 争议流程（草图）

TAP-22 托管的未来扩展或专用 `Dispute` 合约提供：

```
dispute(Envelope e, bytes inputBits, bytes claimedOutputBits) payable
  // 举证人交纳保证金。合约：(1) 由 e 重算 TAP-21 摘要并恢复签名者；(2) 在 chainId 56 上经
  // ServiceDirectory.verifyDelegation 与 DeWebHub.accountOf 解析 签名者 → 容器 → 持有者；
  // (3) 检查 inputBits/claimedOutputBits 按 tapi-bits-v1 编码了 e.params / e.result；
  // (4) 以 verifier.maxGas 调用 eval(verifier.tokenId, inputBits)；
  // (5) 若输出 != claimedOutputBits，将提供者部分质押罚没给举证人；否则保证金没收给提供者。
```

争议合约 MUST NOT 依据电路输出以外的任何东西裁决。由于电路位于 chainId 56，无论调用在哪条链上付费，争议都在 chainId 56 上裁决。质押是未来工作（见 TAP-23 §3.6）；在其存在之前，败诉的争议只产生一个链上事件。

### 3.5 适用性

适合：游戏回合结算规则；抽奖与随机数合成；哈希、校验和与编码器；小型状态机；门预算内的二值神经网络推理。不适合：超出门预算的任何东西；大模型推理；输出依赖电路无法作为输入接收的数据（时间、他链状态、私有数据库）的方法。提供者 MUST NOT 在输出依赖编码未覆盖之输入的方法上列出 `verifier`。

## 4. 原理

- **重执行而非证明。** zk 系统需要证明者、可信或透明设置、以及每电路一个验证合约。在链上重算同样的门无需这些，且只有在有人争议时才花 gas。
- **电路写在清单而非响应中。** 该关系是方法的属性，固定在被签名的清单里，因此提供者不能逐次调用更换电路。
- **编码推迟。** 猜测比特布局只会产出没有实现能满足的规范。TODO 是显式的，也是 `docs/CROSSCHAIN.md` §5 中 v0.3 的门槛。
- **任意电路，不限于服务自身。** 服务可以出售由其并不拥有的社区电路验证的方法；电路持有者的激励是另一回事，不在范围内。

## 5. 向后兼容

增加一个 OPTIONAL 方法描述符字段。不向 `SPEC.md` 添加任何内容，不改变名称语法 `<#ID>.<processor number>.tape`，不改变任何 §15.1 不变量。不认识 `verifier` 的客户端将其忽略。

## 6. 测试向量

| 项目 | 值 |
|---|---|
| 示例 `verifier` | `{ "circuits": "0x…", "tokenId": "1337", "encoding": "tapi-bits-v1", "maxGas": 6000000 }` |
| 一个 PoD 加法器电路：`(input, output)` 对、其比特向量与 `eval()` gas | TODO（受 §3.3 阻塞） |
| 主网（chainId 56）`eval()` 调用与结果 | Final 前 TODO |

## 7. 参考实现

- 使用网表模拟器的 SDK 本地重算，以及一个把 PoD 加法器暴露为验证方法的示例服务，为 v0.3 交付项（`docs/CROSSCHAIN.md` §5）。
- 争议合约：v0.4，审计后。撰写本文时均不存在。

## 8. 安全考量

- **虚假 `verifier`。** 提供者可能指定一个并不计算所宣称函数的电路。客户端 SHOULD 在付费前对几组已知输入输出模拟网表；质押存在后，争议流程使错误的 `verifier` 与错误答案代价相同。
- **gas 消耗攻击。** `maxGas` 限定争议成本；争议合约 MUST 拒绝求值超出区块 gas 预算的电路，而非让举证人无法举证。
- **编码歧义。** 同一 JSON 的两种有效编码会让提供者辩称举证人编码有误。因此 §3.3 要求编码确定性且可由 ABI 数据重现。
- **电路升级或转让。** 电路流片后不可变；代币转让改变持有者但不改变网表。因此 `verifier` 绑定的是函数而非主体。
- **链下偏差。** 使用比电路更快实现进行计算的提供者 MUST 保证比特级等价，包括溢出与边界情况；定义是电路而非快速路径。

## 9. 版权

Copyright and related rights waived via CC0-1.0.
