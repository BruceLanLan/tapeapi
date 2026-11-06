# Agent 护照（实验性）

**Agent 护照**把一个 ERC-8004 agent 身份与一枚 TapeOut 电路关联起来（电路的容器托管着 agent 的服务），让任何人都能只读地核对：
这个身份与这个服务属于同一个持有人。TapeAPI 3.0 为它加了解析器：独立包 `@tapeapi/passport`，以及命令 `tapeapi passport`、
`tapeapi-doctor --passport`、`tapeapi connect --passport` 与 `tapeapi init --passport`。

> **这里的一切都是实验性的**，依据一份未合并的草案：TapeOutProtocol/TAPs 的 PR
> [#83](https://github.com/TapeOutProtocol/TAPs/pull/83)，头 `cae25e6`，**尚未合并**（已提交，评审中）。文字与向量都可能变；每个结果都带着解析时依据的头。草案此后已有更新（现在的头是
> `cbf4e03`）：本包实现的是 `cae25e6` 时的文字，跟进新文字的包已列入计划。
> **主网上目前还不知道有任何护照解析为 CONFIRMED**：草案里的两个真实读取（agent #1、电路 #4246@0）都是 BROKEN，草案作者本人的
> 主网小额实跑也还没有进行。TapeAPI 读取 ERC-8004 在 BNB 链上已部署的公开注册表来互通；这不是 ERC-8004 的扩展，也没有得到其作者
> 或注册表运营者的背书。本包**不受兼容承诺约束**：可能在任何一次发布中改变或撤下。

## 护照说明什么，不说明什么

只有当下面每一条都在同一个钉块上成立、且每次读取都由至少两家运营方的全部已配置节点一致回答（严格共识）时，解析器才报 **CONFIRMED**：

- 同一个钱包（持有人）同时持有身份与电路（P-1）；
- 身份带着元数据键 `tap.passport` = `abi.encode(56, 处理器, #ID)`，指向这枚电路（P-2 至 P-4）；
- 电路的容器已开通（P-5）；
- 容器站点里有 `/.well-known/agent-registration.json`：其 `tap` 成员与链上一致、有 `tape://<链上名>` 服务条目、只列出这一个身份（P-7、P-10）；
- 没有早先持有人设置、至今仍有效的站点操作员（P-8）；
- 注册表的 agent 钱包等于持有人（P-9）。

先读链、最后读文件，所以文件只能增加问题，不能消除问题。结果是一个状态词、一个具名原因与全部警告：

| 状态 | 含义 |
|---|---|
| CONFIRMED | 全部规则成立；结果同时写明哪些没能检查 |
| BROKEN | 有一条绑定事实不成立；原因写明是哪一条（例如 `registration-file-missing`、`holder-mismatch`） |
| AMBIGUOUS | 持有人的文件为这个注册表列出了多个身份；全部显示，不挑选任何一个 |
| wallet-unset | 只有 agent 钱包不成立：身份换手时被清空；持有人可以自己重新设置 |
| stale-agent-wallet | agent 钱包是另一个地址；这个地址绝不显示为付款地址 |
| UNAVAILABLE | 读取未能一致（节点、超时、分歧、注册表已升级）：什么都无从得知 |

护照只说明同一个钱包持有两枚代币、且持有人公布了这一关联。它不说明 agent 运行什么代码，也不说明它诚实或安全；它不是凭证，
也不带来任何收入或资产上的权利。回执只证明签名方所说的内容。

## 需要知道的限制

- **注册表可以升级。** 两个 ERC-8004 注册表都是 UUPS 代理。2026-10-28 读到的 owner 是一个代理合约，对 `getThreshold()` 答 3、
  `getOwners()` 答 5 个地址，形如 3-of-5 的 Safe。解析器钉住草案列出的实现；一旦升级，每个结果都是 UNAVAILABLE（`registry-changed`），
  直到新版本接受新的实现。
- **赠送的身份与电路。** 在已部署的注册表上，任何人都能用任意 URI 与元数据登记一个身份，并在对方不知情时转给任何钱包；电路也可以这样转手。
  agent 钱包、文件列名与"一个电路"三条规则（P-9、P-10、P-11）让这类代币解析不成护照；TapeAPI 也从不按所有者列出身份。按所有者列身份的
  其它工具，仍会在受害者地址旁显示陌生人的文字。
- **站点操作员与持有人历史需要能查日志的节点。** P-8 与持有人纪元（§7："持有人于块 n 变更：此前的声誉不属于当前持有人"）需要
  `eth_getLogs` 历史，公共节点不提供长区间。没有能查日志的节点时，两者报为 `operators-not-checked` 与 `transfer-history-unavailable`，
  CONFIRMED 的结果写明"站点操作员未检查；持有人历史未检查"。拿不到的历史绝不当作空历史。
- **只能签 EIP-712 的钱包。** 这样的持有人可以设置 agent 钱包（`setAgentWallet` 本身是 EIP-712），但无法派生 TapeSend 密封收件箱
  （那需要 `personal_sign`）。这不是护照的故障。
- **隐私。** 护照会把钱包、身份、容器、站点与评价公开且永久地关联在一起。
- **形近字检查是一张固定的表。** `tap` 内的禁用成员名（如 `reward`、`points` 这类与钱有关的词）在 NFKC 与草案的 31 个西里尔、
  希腊字母表（及其大写）之后查找。它抓不到所有形近字，这里也不这样声称。

## 安装

`@tapeapi/passport` 是独立的包（版本 0.1.0），实验性，不在兼容承诺之内。它是与 SDK 同一个 GitHub 发布上的 tgz，需要同一发布的 SDK，
先装 SDK：

```bash
npm install https://github.com/BruceLanLan/tapeapi/releases/download/v3.0.0/tapeapi-sdk-3.0.0.tgz
npm install https://github.com/BruceLanLan/tapeapi/releases/download/v3.0.0/tapeapi-passport-0.1.0.tgz
```

见 [passport/README.md](../../../passport/README.md)。

## 解析

```bash
tapeapi passport 4246.0.tape                # BNB 链上的 TapeOut 名字（示例）
tapeapi passport 1001                       # ERC-8004 的 agentId
tapeapi passport 0x50a9...9dd9#4246 --json  # 处理器合约与 #ID
```

退出码：0 CONFIRMED；1 不是护照或尚未确认（会写明原因）；2 用法错误或未安装该包；3 读不到：请重试。要检查站点操作员与持有人历史，
请给出两家能查日志的节点，以及注册表部署之前的一个块号：

```bash
tapeapi passport 1001 --logs-rpc https://logs-a.example,https://logs-b.example --logs-from <块号>
```

扫描从这个块到钉块分块进行（默认每块 5,000 个区块），有请求预算（64）；任何一块被拒、日志节点没有钉块、或超出预算，历史都重新算作"未检查"。

代码里：

```js
import { createTapeAPI, rpcUrlsFor } from '@tapeapi/sdk'
import { resolvePassport } from '@tapeapi/passport'

const api = createTapeAPI({ rpcUrls: rpcUrlsFor(56) })
const r = await resolvePassport({ name: '4246.0.tape' }, { api })
// r.state、r.reasons、r.warnings、r.checked、r.display.en / r.display.zh、r.draft.head
```

给了 `api` 时，解析器使用该客户端的节点与处理器表（`api.chain.processorNumber`，为此新增的实验性 SDK 方法）；它给出的编号再经一次
严格的 `cpuAt` 读取核对。`recordSnapshot: true` 把读取导出为 `tap-agent-passport-snapshot/1`，可用 `resolveFromSnapshot` 离线重放。

## 在其它命令里

- `tapeapi-doctor <名字> --passport`：在"清单格式"之后多一项，不属于 14 项。CONFIRMED 记为 pass，或给警告并写明没查什么；
  "这个服务没有发布护照"记为跳过，不算失败（服务不一定需要护照）；其它状态给警告；UNAVAILABLE 为"无法判定"。
- `tapeapi connect <名字> --passport`：卡片旁多一节护照。服务能否使用的判断不变。
- `tapeapi init --passport --agent-id <n> --name <名字> [--gateway-domain <域名>]`：单独的一步。只读检查（身份所有者即电路持有人；
  身份的 `tap.passport` 键指向这枚电路；清单的 SHA-256 取自站点存储）之后，在 `--dir` 写出 `.well-known/agent-registration.json`，
  并打印你接下来在自己钱包里做的事：在持有人操作台用 `putFile` 写入这个文件（费用由你支付），并使用规范形式的 `agentURI`
  `https://<标签>.<网关域名>/.well-known/agent-registration.json`（其它形式只会得到警告 `agent-uri-not-canonical`）。它不登记、
  不发送任何东西。从你的 `register` 交易到这次 `putFile` 之间，你自己的身份会解析为 BROKEN：登记之后请立刻写入文件。

**委托期。** 草案 W-1 规定：请持有人签 TAP-11 委托的工具，默认提议的期限不得超过 30 天，宜不超过 7 天。3.0 起持有人
操作台（`tapeapi init` 指向的那个）提议 30 天，持有人也可以填 1 到 366 之间任意整数天（包括 7 天）；所以 TapeAPI 的引导流程守住了 W-1 的
30 天上限，但没有照它的建议默认 7 天。
包里的 `checkDelegationProposal` 供需要的工具按 W-1 检查。其它草案的期限见下表。

## 期限对照

每份草案限制的是不同的签名对象，数字也不都是同一种限制：硬上限由核验方检查，默认上限只规定工具可以提议多长。TapeAPI 在这里不替任何一份草案做决定。

| 签名对象 | 期限 | 限制种类 | 出处 |
|---|---|---|---|
| 容器代理阶段 0 的授权书（#47） | `expires − notBefore` 至多 30 天（2,592,000 秒）；更长的报 `mandate-too-long`，TapeAPI 也核对这一条 | 硬上限 | TAP-18（#47）草案 §5.1 第 4 项检查 |
| `PolicyBinding`（#84） | 工具默认不得提议超过 30 天，宜至多 7 天；`policyBindingTypedData` 提议 7 天，更长的窗口标 `longWindow` | 工具的默认值；更长的窗口是绑定者自己的选择 | TAPs #84 草案；[策略电路](policy-circuit.md) |
| TAP-11 委托，按 #83 W-1 对工具的要求 | 工具默认不得提议超过 30 天，宜不超过 7 天；持有人可以选更长，直到 TAP-11 的上限 | 工具的默认值 | TAPs #83 草案 W-1 |
| TAP-11 委托本身的上限 | 366 天；TapeAPI 客户端拒绝更长的委托，W-1 也规定任何工具都不得把它作为默认值 | 硬上限 | TAP-11 §4.3 |
| 今天 `tapeapi init` 与持有人操作台提议的 TAP-11 委托 | 默认 30 天（剩不到 7 天时 doctor 会警告）；持有人可选 1 到 366 天 | TapeAPI 自己的默认值：等于 W-1 的 30 天默认上限，长于它建议的 7 天 | 本仓库 |

绑定、授权书与委托都只能由签名者签一份撤销来提前结束：签不了名的持有人（钥匙被冻结、持有人已更换）在到期前无法结束它们，这也是窗口宜短的又一个理由。

## A2A 名片与评价

- `agentCardFromPassport` 只为 CONFIRMED 的护照生成 A2A 1.0 名片（草案附录 B）。只用于显示：不提升状态，也绝不是签名者来源。
  清单没有标记哪些端点提供 A2A，所以由调用方指出。清单带 `mcp` 时，工具列表仍以 `mcp.toolsSha256` 钉住的为准。
- `@tapeapi/passport/feedback` 实现 §10：评价写成 ERC-8004 反馈及其汇总。它是可选的，依赖评价草案 TAPs #54（头 `703b2a9`），
  该草案**尚未合并**；目前还没有人写过这类反馈。

## 怎样测试

草案自己的向量（147 例，`vectors.json`，SHA-256 `7720772c…fca4`）作为测试夹具按哈希钉住、逐字节回放，不进入安装包。同样的 73 个
解析用例还经实时层在假链上、用 SDK 的严格共识客户端再跑一遍。TapeAPI 自己补的用例与草案向量分开存放，覆盖向量没有覆盖的情形：
大写形近字母、成员名里 U+FFFF 以上的码点、登记文件里的小数字面量（`"chainId": 56.0` 无效，`"agentId": 1001.0` 不算列出）。
