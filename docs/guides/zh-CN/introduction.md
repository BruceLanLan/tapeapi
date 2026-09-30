[English](../introduction.md) | 中文

# 简介

**Tape Out 一个电路，它的容器就是你的 API。** TapeAPI 是 BNB Chain 上 [TapeOut](https://tapeout.net) 生态的服务与通信层：
DeWEB 是网站，TapeSend 是消息，TapeAPI 是服务。

今天的 API 等于一个网址、一个账号，再加上信任。TapeAPI 用链上身份取代账号，用任何人都能核对的签名取代信任：

- **服务就是电路。** 谁持有电路 NFT，谁就拥有这个服务。转让 NFT，服务随之转移。
- **每个回答都有签名，并与你的请求绑定。** 客户端用电路持有者在链上授权的密钥核对签名。被篡改、被重放或没有签名的回答
  一律报错，绝不会当作结果返回。
- **无需注册，没有 API 密钥。** 免费方法直接调用。付费方法使用链下凭证，批量在链上结算。没有强制协议费：默认从
  提供者的所得中划出 1% 作为维护贡献，任何提供者都可以把它设为 0。今天没有任何调用收费，托管合约还没有部署。
- **容器之间可以私密通信。** 容器之间的端到端加密通道与群聊，由中继或链本身承载。

## 工作原理

1. **身份。** 提供者在 TapeOut 上 Tape Out 一个电路。电路的容器（一个 ERC-6551 账户）就是服务的地址。
2. **清单。** 提供者把 `.well-known/tapeapi.json` 写进容器的站点：端点、方法、价格、签名密钥，以及持有者对该密钥的
   EIP-712 委托。
3. **解析。** 客户端通过多个必须一致的 RPC 节点从链上读取清单，核对其哈希，并对照电路当前的持有者核对委托。
4. **调用。** 客户端发出请求；服务用被委托的密钥签名回答，签名与这次请求绑定。SDK 只在核对通过后才返回结果。

## 选择你的路径

| 我想要 | 阅读 |
|---|---|
| 现在就免费读取有签名的 BNB Chain 数据，或使用公共中继 | [公共 API](public-api.md) |
| 给 Claude、Cursor 或其他 MCP 客户端提供有签名的工具 | [MCP](mcp.md) |
| 在应用里调用 TapeAPI 服务 | [调用服务](consume.md) |
| 把我的代码或现有 API 变成服务 | [运行服务](provide.md) |
| 在容器之间发送加密消息 | [私密通道](channels.md) |
| 让 AI 代理安全地使用服务 | [AI 代理](agents.md) |
| 排查错误 | [常见问题](faq.md) |

## 状态

正式版，版本 1.3.0。1.0 起遵循语义化版本：按 1.0 文档写的代码在所有 1.x 版本里都能继续工作，破坏性修改只在 2.0
（[1.0 承诺什么](upgrade-1.0.md)）。免费层运行在 TapeOut 已部署的合约之上。我们自己的合约未经第三方审计；付费调用的
托管合约尚未部署。TAPI-20 到 TAPI-27 是 TapeAPI 自己的规范，不是 TAP（2026-09-30 之前叫 TAP-20 到 TAP-27）：TAP 由 [TapeOutProtocol/TAPs](https://github.com/TapeOutProtocol/TAPs) 的编辑编号，这些规范的部分内容已作为 TAP 草稿提交到那里。

## 链上地址

BNB Smart Chain，chainId 56。

| 合约 | 地址 | 所有者 |
|---|---|---|
| DeWebHub | `0xe61A9C7213a6Aa616C246a2B569e555B417b25ee` | TapeOut |
| SiteRegistry | `0xd006ffdd5Ae313B17729621A00999cD3C71CE5e6` | TapeOut |
| 处理器工厂 | `0x68224F668083c29e9800Be2a646d42d18cedF7e2` | TapeOut |
| BEM 代币 | `0x5ce033b2bfca3af30b3e8c8457deaf776a8b695a` | TapeOut |
| ChannelBus | `0x486110c35d9b90a9d6D85c8063A065f9e7b6b707` | TapeAPI：无所有者、无状态、不可升级 |
| TapeAPIEscrow、ServiceDirectory | 未部署 | TapeAPI |

## 公共服务

由本项目运行的免费 TapeAPI 服务，各自对应处理器 1013（`0xe02c26c7432A7121168AA9B610DE24eCf9a1a414`）上的一个电路。
它们是服务，不是合约；见[公共 API](public-api.md)。

| 服务 | 身份 | 容器 | 网址 |
|---|---|---|---|
| 公共 API（8 个读取方法） | `11.1013.tape` | `0x1b2A657BcBa9D3229f57aC2f4FcbEE2AA756aAe8` | `https://api.tapeapi.fun` |
| 公共中继（`relaySend`、`relayHandshake`、`relayRecv`） | `12.1013.tape` | `0x9cD838625251576c199B2DeF7A17e50266843185` | `https://relay.tapeapi.fun` |

公共 API 的方法也以 MCP 工具的形式提供，地址是 `https://api.tapeapi.fun/mcp`，适用于 Claude、Cursor 和任何 MCP 客户端。
每个结果都有签名，并附带任何人都能核验的回执；见 [MCP](mcp.md)。

## 规范

协议以 TapeAPI 自己的规范（TAPI）写成，中英双语（以英文为准），采用 CC0。
这些规范不是 TAP；部分内容已作为 TAP 草稿提交到 TapeOutProtocol/TAPs：[#8](https://github.com/TapeOutProtocol/TAPs/pull/8)、[#10](https://github.com/TapeOutProtocol/TAPs/pull/10)、[#12](https://github.com/TapeOutProtocol/TAPs/pull/12)。

| 规范 | 标题 |
|---|---|
| [TAPI-20](../../../spec/TAPI-20.md) | 服务身份与清单 |
| [TAPI-21](../../../spec/TAPI-21.md) | 签名响应信封 |
| [TAPI-22](../../../spec/TAPI-22.md) | 计量支付 |
| [TAPI-23](../../../spec/TAPI-23.md) | 带证明的跨链读取 |
| [TAPI-24](../../../spec/TAPI-24.md) | 意图询价（已撤回） |
| [TAPI-25](../../../spec/TAPI-25.md) | 可由电路验证的方法 |
| [TAPI-26](../../../spec/TAPI-26.md) | 私密通道 |
| [TAPI-27](../../../spec/TAPI-27.md) | 私密群聊 |

源代码、示例和一致性测试套件都在 [GitHub](https://github.com/BruceLanLan/tapeapi) 上。

## 致谢

为 TapeOut 做一个服务层的想法来自 [@Theairresearch](https://x.com/Theairresearch/status/2101640697426448632)。
TapeAPI 获得的任何收入，永久 10% 归他们。
