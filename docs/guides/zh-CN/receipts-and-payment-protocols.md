[English](../receipts-and-payment-protocols.md) | 中文

# 回执与支付协议（实验性）

TapeAPI 用量回执与 x402、Google 的 AP2、ERC-8004、ERC-8183 以及 IETF 关于证明回执的草案各在什么位置，以及有界代理的授权书与
AP2 的 Payment Mandate 怎样对应。**本页是实验性文档**：一份事实对照，依据 [来源](#来源) 中列出的一手资料，按 2026-10-21 读到的内容写成；x402 与 AP2 的文件在 2026-10-27 又核对了一次，两次读到的不同时，下文写明出自哪一次。
任何次版本都可能修改它。它不描述任何集成：没有适配器，没有支付桥接，这里没有任何东西付款。凡是没能在一手资料里核对的说法，都标
**未核实**。

> **回执证明的是签名者说了什么，不证明运行的是哪个模型。** TapeAPI 回执把服务方的钥匙与确切的请求字节、回答（回答的确切字节；流式回答取其事件数据），以及服务方声称的用量和
> 价格绑在一起。本页的所有格式（包括我们自己的）都不证明回答由哪个模型产生；第 5 节的证明类草案是在尝试这件事，而且只在对硬件的明确
> 假设成立时才成立。

## 1. TapeAPI 用量回执签了什么

清单里带 `ai` 价目表的服务，在 AI 接口前面放一个签名旁路（[TAPI-21 §3.5](../../../spec/TAPI-21.md)、
[AI 服务方](ai-providers.md)）。它对每个回答签一个信封：

- `params.requestSha256`：客户端发出的请求体字节（原样）的 SHA-256；
- `result.responseSha256`：客户端收到的回答字节的 SHA-256（流式回答按固定的解析规则取事件数据）；
- `result.model`、`result.usage`、`result.status`、`result.complete`、`result.stream`；
- `result.prices`：按清单价目表、由这些用量算出的金额，客户端可以复算。

签名者是清单里的 `signer`：电路**持有人**签名委托的钥匙，客户端从链上读到这份委托（[TAPI-20](../../../spec/TAPI-20.md)）。客户端核对
签名、核对它手里那些字节的哈希，并复算价格。

它不说明的事：上游跑的是哪个模型、上游报的用量是否属实、有没有付过钱。付款是另一件事（TAPI-22 凭证，其托管合约未经审计、未部署）。
签名带来的是可追责：服务方不能否认自己签过的回执，买方可以拿回执去对账单（[回执对账](reconcile.md)）。

TapeAPI 更强的一种形式是 [TAPI-23](../../../spec/TAPI-23.md) 的交叉验证读取：客户端向至少两家独立服务方请求同一个只读的链上调用，
有任何不一致即拒绝。这之所以可行，是因为链上读取是确定的；AI 回答不是，所以回执没有"多家一致"的规则。

## 2. x402

x402 是 HTTP 402 付款协议。规范在仓库 `x402-foundation/x402` 里（GitHub 显示 `coinbase/x402` 是它的分叉）；核心文档是
`specs/x402-specification-v2.md`（"Protocol Version: 2"）。

- **方案（scheme）。** `specs/schemes/` 里有四个（2026-10-21 读的提交如此，2026-10-27 仍然如此）：`exact`、`upto`、`batch-settlement`、`auth-capture`。`batch-settlement` 中，客户端的
  付款承诺在请求时被接受，价值稍后才转移（结算时把承诺存起来，而不是执行转账）；结算结果带一个承诺标识，服务方可以收取低于承诺上限的
  金额，在 `PAYMENT-RESPONSE` 里告知。`upto` 为单个请求授权一个上限，只结算一次。上面关于
  `batch-settlement` 的几句说的是抽象方案文件（`scheme_batch_settlement.md`，最后修改 2026-05-05）。2026-10-27 时该目录里还有 EVM、SVM 与
  Cloudflare 的网络绑定（`scheme_batch_settlement_evm.md`、`_svm.md`、`_cloudflare.md`；目录最后修改于 2026-10-26），规定承诺在各网络上
  如何形成与兑付；本页不概述它们。
- **结算响应。** `SettlementResponse` 的字段是 `success`、`errorReason`、`payer`、`transaction`、`network`、`amount`、`extensions`（2026-10-21 读的提交）。
  2026-10-26 的一次修改加了可选的 `errorMessage`（`errorReason` 的人读说明）；2026-10-27 时其中仍然没有请求或回答的哈希。
- **签名收据。** 可选的 "Offer and Receipt" 扩展（`specs/extensions/extension-offer-and-receipt.md`）让资源服务器签一份收据，"只在成功时"
  返回，确认已收款且服务已交付。其签名载荷恰好是 `version`、`network`、`resourceUrl`、`payer`、`issuedAt` 和可选的 `transaction`，以
  EIP-712（域 `"x402 receipt"`，`chainId` 为 1）或 JWS 签名，默认"隐私最小"。扩展自己说明其线上形状"不视为稳定"。（最后修改 2026-07-23；2026-10-27 时未变。）

**已核实：** 批量结算确实是一个方案；x402 收据的签名字段里没有请求哈希，也没有回答哈希。（这是 x402 的两个不同部分：批量结算是方案，
收据是扩展。）

**TapeAPI 回执的位置。** x402 收据说的是"这个付款人在这个时间为这个资源 URL 付了款"。TapeAPI 回执说的是"这个服务的钥匙用这个回答
回答了这些请求字节，并声称了这些用量和价格"。两者回答的是不同的问题，可以并存，谁也替代不了谁。TapeAPI 不说 x402，本页也不提议
任何桥接。（TapeAPI 唯一接触 x402 的部分在别处，也与回执无关：一个实验性、不在任何发布版本里的后端，可以把有界代理的资金放在
x402 批量结算通道里，用的是已部署、不是我们编写的合约，付款方只能是普通外部账户；它既不实现 HTTP 402 交换，也不实现收据扩展，
不改变 TapeAPI 回执签名的任何内容，见 [x402 批量结算通道](container-agents.md#实验以-x402-批量结算通道作执行层实验性)。）

## 3. AP2

AP2 是 Google 的 Agent Payments Protocol，仓库 `google-agentic-commerce/AP2`。最新的标签是 `v0.2.0`（2026-04-28；2026-10-27 时仍是最新标签；
`docs/ap2/specification.md`，"Agentic Payment Protocol (v0.2)"）。

- **Mandate。** v0.2 定义两种：**Checkout Mandate**（买什么，用哈希绑定到商户签名的 checkout JWT）与 **Payment Mandate**（为这次
  checkout 付款）。每种都分**开放**（用户签名、带约束，留给代理去完成）与**封闭**（完整，针对一笔交易）。它们是 SD-JWT 凭据；开放的
  mandate MUST 带 `cnf` 声明，写明代理的持有证明钥匙（RFC 7800）。
- **开放 Payment Mandate 的约束：** `payment.agent_recurrence`、`payment.allowed_payees`、允许的支付工具、允许的 PISP、
  `payment.amount_range`、`payment.budget`（总额，由核验方在多份封闭 mandate 之间累计）、`payment.reference`（把它绑到一份 checkout
  mandate）与 `payment.execution_date`。未知约束"MUST 视为评估失败"；新的约束类型 MAY 用防冲突的名字另行定义。
- **收据。** 处理之后返回 Checkout Receipt 与 Payment Receipt。Payment Receipt 的模式（`code/sdk/schemas/ap2/payment_receipt.json`）
  有 `status`、`iss`、`iat`、`reference`（封闭 mandate 的哈希）、`payment_id` 与若干确认编号：它把一笔付款绑定到一份 mandate，而不是
  绑定到任何回答的内容。
- **旧名字。** v0.1（标签 `v0.1.0`，2025-09-16）有 Intent Mandate、Cart Mandate 与 Payment Mandate。v0.2 用开放与封闭的 Checkout
  Mandate 取代了前两种。
- 在我们读过的 v0.2 文档里没有找到撤销机制。超出这些文档的范围**未核实**。

## 4. 有界代理的授权书与 AP2 Payment Mandate：方向

TapeAPI 容器代理的 `Mandate`（[容器代理](container-agents.md)；阶段 0 是 TAP-18（#47），阶段 1 是草稿 #60）是电路持有人签的 EIP-712 消息：
`principal`、`agent`、`agentKey`、`mode`、`taskHash`、`scope[] { provider, token, cap }`、`feeToken`、`feeCap`、`notBefore`、
`expires`、`nonce`、`subdelegate`，另有单独的 `MandateRevocation`。下表对应的是字段，**不是执行方式**；只是方向，没有适配代码，也没有
支付桥接。

| Mandate（TapeAPI） | AP2 v0.2 中最接近的项 | 差别 |
|---|---|---|
| `principal` 签名 | 用户在 Trusted Surface 上签开放 mandate | secp256k1 的 EIP-712，对 SD-JWT（AP2 的示例用 P-256 钥匙） |
| `agentKey` | 开放 mandate 的 `cnf` | 角色相同：日后证明代理在该授权下行事的钥匙 |
| `scope[].provider` | `payment.allowed_payees` | TapeOut 容器地址，对商户列表 |
| `scope[].cap`、`scope[].token` | `payment.budget`、`payment.amount_range` | 代币最小单位（uint256），对 ISO 4217 币种加金额 |
| `notBefore`、`expires` | `payment.execution_date`、`exp` | 我们用 Unix 秒；AP2 的 `exp` 是 Unix 秒，`execution_date` 的时间窗是 ISO 8601 |
| `taskHash` | `payment.reference`（勉强） | AP2 把付款绑到一次 checkout；我们把授权书绑到一段任务文本 |
| `mode`、`feeToken`、`feeCap` | 没有找到 | |
| `subdelegate` | 开放到封闭的链 | AP2 是否允许代理再委托：**未核实** |
| `MandateRevocation` | 没有找到 | |

**执行方式不同。** 阶段 0 的授权书上限必须为零，它不限制任何支出。阶段 1（有界代理）的上限是持有人注资的托管通道余额，依托 TAPI-22
的托管合约，而该合约**未经审计、未部署**在任何链上，所以在主网上不能用。AP2 的上限来自核验方（凭据提供方、商户、支付处理方）对约束的
确定性评估。

**以后可能的一步**（未决定、未构建）：一个页面或文件，把一份已签授权书的事实与它们在 AP2 里的名字并排列出，让熟悉 AP2 的读者能读懂
我们的格式；如果有人提出需要，再按 AP2 新类型的规则定义一个 TapeAPI 约束类型。签发或接收 AP2 mandate、在两者之间转移资金，都不在范围内。

## 5. ERC-8004、ERC-8183 与证明类回执

**ERC-8004 "Trustless Agents"**（Draft，创建于 2025-08-13；依赖 EIP-155、EIP-712、EIP-721、EIP-1271）：身份注册表（ERC-721）、
声誉注册表（`giveFeedback`，参数 `agentId`、`value`、`valueDecimals`、`tag1`、`tag2`、`endpoint`、`feedbackURI`、`feedbackHash`；
链下反馈文件可带 `proofOfPayment`，正文说可用于 x402）和验证注册表（`validationRequest`、`validationResponse`，0 至 100 的分数），
面向 TEE 证明、zkML、重新执行等验证者。反馈条目指向的文件可以是一份 TapeAPI 回执；在那里登记任何东西都要付 gas，目前没有计划。

**ERC-8183 "Agentic Commerce"**（Draft，创建于 2026-02-25；依赖 EIP-20）：一项工作，预算以 ERC-20 托管，有委托方、提供方和一个评估者，
只有评估者能把它标为完成或拒绝。`submit` 接收 `bytes32 deliverable`（引用，例如哈希），`complete` / `reject` 接收可选的 `bytes32 reason`
（例如证明哈希）。合约不检查交付物。回执的哈希两个位置都放得下；目前没有计划。一份仍开着的 TAP 草案 Circuit Jobs（电路作业）
让一个合约充当这种工作的评估者，由争议博弈来结算；TapeAPI 不为它提供代码（[Circuit Jobs](circuit-jobs.md)）。

EIP 页面不显示最后修改日期；这两段摘要按 2026-10-21 读到的页面写成，没有对照 ERC 仓库的历史核对。

**IETF。** RATS 架构（[RFC 9334](https://datatracker.ietf.org/doc/rfc9334/)，2023 年 1 月，Informational）把证明方的 Evidence 与
验证方的 Attestation Results 分开；[draft-ietf-rats-ear-04](https://datatracker.ietf.org/doc/draft-ietf-rats-ear/)（2026-05-26，RATS
工作组草案）对这些结果进行编码。两份个人草案（不是工作组文档）定义了 AI 推理的回执：

- [draft-tsyrulnikov-rats-attested-inference-receipt-02](https://datatracker.ietf.org/doc/draft-tsyrulnikov-rats-attested-inference-receipt/)
  （2026-07-05，Informational）：TEE 内工作负载签发的 COSE_Sign1 回执（CWT 声明，按 EAT 规范化，Ed25519），绑定 `model_hash`、
  `request_hash`、`response_hash` 与平台证明文档的哈希。它说明单凭 `model_hash` 不能证明模型运行过，TEE 来源只有在四项信任假设
  （硬件、诚实的工作负载、与被证明的工作负载绑定的钥匙、能核对厂商证书链的验证方）都成立时才成立。
- [draft-chueayen-attestation-receipts-03](https://www.ietf.org/archive/id/draft-chueayen-attestation-receipts-03.html)
  （2026-09-20，Informational）：对一次推理决定的 Ed25519 签名 JSON 回执，含请求哈希、模型标识与结果，没有回答哈希。它自称应用层
  证据，并把"所声称的模型确实运行了"列为仅凭该格式无法确立的事项。

SCITT 架构（[RFC 9943](https://datatracker.ietf.org/doc/rfc9943/)，2026 年 6 月）与 COSE Receipts（[RFC 9942](https://datatracker.ietf.org/doc/rfc9942/)，
2026 年 6 月）从另一面说了同一件事：那里的收据证明一条声明被登记进了透明日志，而"登记一条声明只证明它由某个签发者产生"。

TapeAPI 回执是同一类应用层证据：服务方签的一条声明，两边字节都有哈希，价格可以复算，没有硬件证据。要说明运行的是哪个模型，需要 TEE，
并且要信任它的厂商；TapeAPI 不做这件事。

## 6. 并排对照

| | 签名方 | 请求字节 | 回答字节 | 用量与价格 | 付款 | 运行的是哪个模型 |
|---|---|---|---|---|---|---|
| TapeAPI 回执（TAPI-21 §3.5） | 服务的钥匙，由持有人在链上委托 | SHA-256 | SHA-256（流式回答：其事件数据） | 有，可复算 | 无 | 不证明 |
| x402 收据（扩展） | 资源服务器 | 无 | 无 | 无（金额经可选的 `transaction` 查） | 有，仅成功时 | 不涉及 |
| x402 `SettlementResponse` | 核心模式中没有签名 | 无 | 无 | 可选的 `amount` | 有 | 不涉及 |
| AP2 Payment Receipt | 签发方（`iss`） | 无 | 无 | 无 | 有，绑定封闭 mandate | 不涉及 |
| ERC-8004 反馈 | 评价者的交易 | 无 | 无 | 无 | 可选的 `proofOfPayment` | 不涉及 |
| ERC-8183 工作 | 评估者的交易 | 无 | 一个 `bytes32` 引用 | 无 | 托管的预算 | 不涉及 |
| 推理证明回执（草案） | 绑定 TEE 工作负载的钥匙 | 哈希 | 哈希 | 无 | 无 | 仅在其四项假设下 |
| Chueayen 回执（草案） | 签发方（Ed25519） | 哈希 | 无 | 成本估计 | 无 | 不能确立 |

## 来源

2026-10-21 只读查阅。仓库文件经 GitHub API 读取。

- x402：`x402-foundation/x402`，提交 `faa1c694c6`（2026-10-15）：`specs/x402-specification-v2.md`（最后修改 2026-08-31）、
  `specs/schemes/batch-settlement/scheme_batch_settlement.md`（2026-05-05）、`specs/schemes/upto/scheme_upto.md`、
  `specs/extensions/extension-offer-and-receipt.md`（最后修改 2026-07-23，提交 `69652a6979`）。<https://github.com/x402-foundation/x402>
- 2026-10-27 经 GitHub API 只读复核：x402 提交 `6b578ecc83`（2026-10-27）：`specs/x402-specification-v2.md` 最后修改于
  2026-10-26（`51a0664c2b`：结算响应加可选的 `errorMessage`，核验响应加 `invalidMessage`）；`specs/schemes/` 仍是 `auth-capture`、
  `batch-settlement`、`exact`、`upto`；`specs/schemes/batch-settlement/` 里有 `scheme_batch_settlement.md`（仍是 2026-05-05）以及
  `_cloudflare`、`_evm`、`_svm` 三个绑定；`extension-offer-and-receipt.md` 未变。AP2：标签 `v0.2.0` 与 `v0.1.0`，没有更新的。
- AP2：`google-agentic-commerce/AP2`，标签 `v0.2.0`（2026-04-28）与 `v0.1.0`（2025-09-16）：`docs/ap2/specification.md`、
  `payment_mandate.md`、`checkout_mandate.md`、`agent_authorization.md`、`code/sdk/schemas/ap2/payment_receipt.json`、
  `payment_mandate.json`；v0.1 的 `docs/specification.md`。<https://github.com/google-agentic-commerce/AP2>
- ERC-8004：<https://eips.ethereum.org/EIPS/eip-8004>。ERC-8183：<https://eips.ethereum.org/EIPS/eip-8183>。
- IETF：RFC 9334、draft-ietf-rats-ear-04、draft-tsyrulnikov-rats-attested-inference-receipt-02、draft-chueayen-attestation-receipts-03、
  RFC 9942、RFC 9943（链接见第 5 节）。

**未核实或未写入：** x402 Foundation 的成立日期与成员（各来源说法不一）；AP2 是否移交给其他组织；所列文件以外的 x402 方案内容；
AP2 Checkout Receipt 的模式；两份 IETF 个人草案将来是否会被工作组接手。
