# 策略电路（实验性）

服务方被要求先为代理服务、后收款时，看不到代理钱包在后台保存的限额。**策略电路**（policy circuit）是把支出规则写成一个小型
`tapnet/1` 电路，按哈希逐字节固定；代理的委托人用 EIP-712 签名把它**绑定**（PolicyBinding）在一份授权书、一个托管会话或一个账户上。
拿到绑定的对方对眼前的请求重跑这个电路，自己就能看出请求是否在规则之内。实验性的 `@tapeapi/policy-circuit` 包（0.1.0，独立包，
不属于 SDK）按 Policy Circuit Gate TAP 草稿实现这件事。

> **它不是什么。** 它是**链下核查**，只**约束去核查它的一方**：代理的钱包可以不理会它，对任何不核查的一方都可以超出规则支出。它**不是签名护栏**，
> 绑定也不保证代理不会超支。按周期的上限只计一个守门方见到的请求。草稿是一个 pull request（TAPs #84，有条件的草稿），已提交，目前转为 draft PR，**未合并**；
> 它所依托的草稿中，TAP-18 的授权书（来自 #47）已合并为 Draft（合并不等于被采纳），托管草稿（#59、#60）已提交（评审中）；托管合约未经审计、未部署。策略电路**没有任何部署**（没有守门合约，也没有带 Eval
> 扩展的网表 NFT 合约），本包不发送任何交易。这里的一切在任何版本都可能改动或移除：本包**不受兼容承诺约束**。

## 1. 组成

| 部分 | 是什么 |
|---|---|
| 策略文件 | 一个 `tapnet/1` 网表（只有 NAND 与 LATCH 记录），128 个输入引脚、8 个输出引脚，至多 49,152 字节。以网表哈希（文件的 SHA-256）识别。含 LATCH 记录即为**有状态**，在一个守门方依次给出的请求之间保留状态。 |
| 表 | `{ assets, counterparties }`：规则涉及的每个资产地址各有类别（1–255）和自己的单位（`{ class, unit }`，单位是十进制字符串：该资产每个金额单位对应的基本单位数）；每个对手方地址有类别。表哈希在签名之内，所以只改一个资产的单位就是另一个绑定。 |
| 请求字 | 由 `{ amount, asset, counterparty, kind, ts }` 与表算出的 128 位：以单位计的金额（**向上**取整，饱和时置溢出位）、两个类别、种类（付款、注资、调用、转账、其它）、UTC 的日、时与星期。核验方一律自己重算，绝不信任请求方给的字。 |
| 结果 | 一个字节：只有恰好 `0x01` 放行；其它一律拒绝并给出原因码（放行位与原因同时置位是无效结果，按拒绝）。 |
| 绑定 | `PolicyBinding(netlistHash, subjectKind, subject, tablesHash, notBefore, expires, issued)`，在 TAP-11 的 EIP-712 域里（名字 `TapeAPI`、中枢、主体所在链）由主体种类指定的**绑定者**签名。可由同一签名者的 `PolicyBindingRevocation` 撤销。 |

主体种类，以及检查至多能报告什么（写死在代码里，没有选项可改）：

| 种类 | 主体 | 绑定者 | 至多报告 |
|---|---|---|---|
| 1 `mandate` | TAP-18 草稿（来自 #47）的授权书哈希（SDK 的 `mandateHashOf`，已与该草稿的向量核对一致） | 授权书委托方的当前持有人 | `conditional` |
| 2 `escrow-session` | #59 / #60 托管通道的 `keccak256(escrow ‖ consumer ‖ provider ‖ key)` | 通道的付款方（付款方是合约时为其持有人） | `conditional` |
| 3 `account` | 一个 TapeOut 电路的容器地址 | 该电路的持有人，绝不是账户本身（`binding-self-signed`） | `true`：签名者有权约束该账户（不表示有谁在强制执行） |
| 4 `label` | `keccak256(label)` | 任何人 | `false`：仅供展示，不约束任何人 |

`conditional`（有条件）的意思是：各项检查都没有问题，但绑定者规则依托的草稿仍可能改动；它只约束去核查它的一方。`enforceable` 只表示签名者有没有权力约束该主体，不表示守门方、钱包、托管或合约会遵守或强制执行这个绑定。手上没有策略文件就没有结论
（`enforceable` 绝不为 `true` 或 `conditional`）；绑定者没有核对时 `enforceable` 为 `null`。

## 2. 检查一个绑定

```js
import { checkPolicyBinding, verifyPolicyBinding, policyBinderFromApi } from '@tapeapi/policy-circuit'

// 绑定者已知（ECDSA 签名者）：
const r = checkPolicyBinding(56, binding, sig, tables, { now, policyFile, binder: holder, revocations })
r.problems      // 草稿的问题名，按草稿的顺序（binding-expired、tables-hash-mismatch 等）
r.enforceable   // true | false | null | 'conditional'
r.display.zh    // 例如"有条件：绑定者规则依托的草稿仍可能改动；只约束去核查它的一方"

// 绑定者从链上读取：在一个 TAP-10 钉块上读持有人；持有人是合约时，在同一个块上按 EIP-1271 询问
const reader = policyBinderFromApi(api, { rpc, chainId: 56 })
const v = await verifyPolicyBinding(56, binding, sig, tables, { now, policyFile, binder: reader })
```

撤销的签名者**从撤销自己的签名恢复**；没有签名的条目忽略。合约绑定者（例如持有电路的 Safe）只能经读取函数按 EIP-1271 核对：没有读取函数，
或读取失败，结果写 `binderChecked: false`、`enforceable: null`，绝不算核对成功。手上有授权书或会话时请一并传入（`mandate`、`session`）：
绑定必须指向它；绑定窗口落不进它的窗口即 `binding-outlives-subject`。托管会话绑定的守门方必须拿到会话（见第 4 节）。

绑定者在自己的控制台里签名：`policyBindingTypedData(chainId, { netlistHash, subjectKind, subject, tables })` 给出 EIP-712 载荷，默认窗口 7 天。
本包不签任何东西；读取他人文本的运行时（代理）不得签绑定或撤销。

## 3. 在服务里做守门方

```js
import { createPolicyGate, policyTraceFileStore } from '@tapeapi/policy-circuit'
import * as fs from 'node:fs'

const gate = await createPolicyGate({
  chainId: 56, binding, sig, tables,
  fetchPolicyFile: async (netlistHash) => fileFor(netlistHash),   // 或 policyFile
  binder: reader,                                                 // 或持有人地址
  revocations: () => currentRevocations(),                        // 每次判定前重新读取
  store: policyTraceFileStore('./policy-trace.jsonl', fs),        // 只追加，权限 600，带锁
})
await gate.startTrace({ reason: 'first use of this binding' })   // 有状态策略需要显式开始
const v = await gate.admit({ amount: '1000000000000000', asset, counterparty, kind: 1 })
if (v.verdict === 'allow') { /* 服务或结算 */ }
```

绑定没有核对成功的守门方，`startTrace` 与每次 `admit` 都返回拒绝结果（原因见 `gate.status()`）。
守门方用自己的时钟给 `ts`，每个请求推进一拍，无论放行与否。草稿失败表里的每一种情形都失败即拒绝：

| 情形 | `admit` |
|---|---|
| 拿不到策略文件、哈希不符、文件无效或引脚不对 | 拒绝（`policy-file-unavailable`、`policy-hash-mismatch`、`policy-invalid-file`、`policy-bad-pins`） |
| 绑定未生效、已过期（每次判定前都重查）、已撤销、未签名、签名者不对、自签 | 拒绝并给出问题名 |
| 签名之后表被改动 | 拒绝（`tables-hash-mismatch`） |
| 绑定者未核对，或标签绑定 | 拒绝 |
| 绑定签好之后电路转手 | 下一次判定即拒绝（`not-signed-by-binder`）：每次判定前都重新读取绑定者，读取失败也拒绝（`binder-not-checked`） |
| 无效的结果字节 | 拒绝，并标 `invalidResult` |
| 撤销读不到 | 拒绝（`revocations-unavailable`） |
| 有状态策略：存储里没有轨迹、有坏行、记录的结论重放不出来、写入失败 | 拒绝（`trace-unavailable`）；重开只能用 `startTrace({ reason })`，并写进轨迹 |
| 同一签名者、同一主体的两个有效绑定 `issued` 相同 | 拒绝（`binding-ambiguous`）；否则用 `issued` 较大的那个 |

状态从不单独保存，而是从轨迹重建：进程重启（或同一文件上的第二个进程）会接着轨迹继续。`gate.trace()` 给出的条目就是 `replayPolicyTrace`
接受的形式，对方可以逐条复核每个结论。

## 4. 托管会话，以及 x402 通道为什么不是第 2 类

第 2 类绑定的守门方接收凭单的 `cumulative` 而不是金额：交给策略的金额是相对上一个**已放行**累计值的增量，累计值变小即拒绝
（`trace-cumulative-decreases`）。被守门方拒绝的凭单仍可能被任何人结算，因为托管合约不读这道门；此时门的累计值落后于通道，下一次的增量偏大，
偏向拒绝。

第 2 类只指 #59 / #60 托管接口的通道。TapeAPI 实验性的 x402 批量结算后端也有会话钥匙，但合约不同、凭单类型不同，也没有会话到期，所以不是第 2 类
主体：`policySubject.escrowSession` 与 `createPolicyGate` 都拒绝它（`INVALID_ARGUMENT`，`data.reason` 为 `policy-subject-x402`，这是 TapeAPI
自己的名字，不是草稿的问题名）。这类通道请用账户绑定（第 3 类）或标签（第 4 类，仅供展示）。第 2 类的 subject 只是四个地址的哈希，
要拒绝 x402 通道就离不开会话：第 2 类绑定调用 `createPolicyGate` 而不传 `session`，会抛出 `INVALID_ARGUMENT`（`data.reason` 为
`policy-session-required`）。

## 5. 不是本地预算

SDK 的本地预算（`--policy`、`createBudget`）是你自己进程里的便利，别人无法依赖；策略电路是对方可以重跑的规则，但也只约束去核查它的一方。
两者不能互相替代，本版也没有从一方到另一方的编译器。预算规则若写成电路会怎样：

| 预算规则 | 在请求字里 | |
|---|---|---|
| `service`（容器地址） | 对手方类别 | 能写成电路 |
| `period: call` 的 `maxAmount` | 以单位计的金额（向上取整） | 能写，每个资产选定各自的单位 |
| `period: day` 的 `maxAmount` / `maxCalls` | 日索引与电路里的锁存器 | 能写（类似草稿的 `daily-cap` 示例，每天至多 65,535 个单位） |
| `currency: USD`（回执声称的价格） | 资产类别需要一个地址 | 不能：美元没有资产地址 |
| 代币计价 | 资产类别 | 能写（以代币合约为键） |
| `model`、`maxPromptTokens`、`maxCompletionTokens` | 没有 | 不能 |
| `period: month` / `total` | 只有日索引 | 本版没有 |
| 先按最坏情况计、回执到了再改正；released 行 | 轨迹只能向前 | 不能：电路只能按最坏情况计 |

## 6. 绑定窗口

`policyBindingTypedData` 提议的策略绑定默认 7 天；工具默认不得提议超过 30 天（更长的是绑定者自己的选择，标 `longWindow`）。授权书（TAP-18，来自 #47）
与 TAP-11 委托（#83 W-1，以及 TapeAPI 今天提议的期限）的期限都在 [Agent 护照指南](passport.md#期限对照)的同一张表里。

本包不替任何一份草稿做决定。绑定只能由它的签名者撤销：签不了名的持有人（钥匙被冻结、持有人已更换）在绑定到期前无法撤销，所以窗口宜短。
账户背后的电路易主之后，之前的绑定在核对绑定者时对不上新持有人。

## 7. 现状

- 草稿：TAPs pull request #84（Policy Circuit Gate），已提交，目前转为 draft PR，有条件，未合并；本包跟随其头提交 `0b73174`。
  与较早的头 `7827c07` 相比：表改成每个资产各有类别和单位（取代单一的 `amountUnit`，所以所有表哈希与绑定哈希都变了），
  表里没有的资产现在一律溢出；较早的表格式即 `tables-malformed`。
- 测试复现草稿向量的全部 188 例（按 SHA-256 钉住的副本，放在测试旁边，不进包），有 `python3` 时还对照草稿的 Python TAP-02 参考实现做
  10,000 拍随机比对。
- 本版没有：预算到电路的编译器、`@tapeapi/server` 里的挂点、链上调用约定（`evalFile` / `stepFile`）、Circuit Jobs。没有任何部署，没有交易。

包的说明在 [policy-circuit/README.md](../../../policy-circuit/README.md)。
