# 文档地图 / Documents

**从这里开始 / Start here:** [`README.md`](../README.md)（[中文](../README.zh-CN.md)）→ [`docs/guides/`](guides/) → [`DESIGN.md`](../DESIGN.md) → [`spec/TAP-20.md`](../spec/TAP-20.md) → [`examples/README.md`](../examples/README.md).

## 指南 / Guides

英文 [`docs/guides/`](guides/)，中文 [`docs/guides/zh-CN/`](guides/zh-CN/)。English and Chinese.

| 指南 / Guide | 是什么 / What |
|---|---|
| [调用服务 / Call a service](guides/consume.md) | 解析、调用、校验、错误码、法定人数、付费。Resolve, call, verify, errors, quorum, payment. |
| [运行服务 / Run a service](guides/provide.md) | 本地运行、用手机或服务器上线、续期、运营。Run locally, go live from a phone or a server, renew, operate. |
| [私密通道 / Private channels](guides/channels.md) | 通道密钥、握手、中继与 ChannelBus、读链告警。Keys, handshake, transports, reader warnings. |
| [AI 代理 / AI agents](guides/agents.md) | 用 WebMCP 把服务暴露给浏览器里的代理。WebMCP tools for agents. |
| [常见问题 / FAQ](guides/faq.md) | 常见问题与排错。Questions and troubleshooting. |

## 规范 / Specifications

双语，英文为准，CC0-1.0。Bilingual, English authoritative, CC0-1.0.

| 文件 | 是什么 / What |
|---|---|
| [`spec/TAP-1.md`](../spec/TAP-1.md) | TAP 流程：类型、状态、编号、必需章节。The TAP process. |
| [`spec/TAP-20.md`](../spec/TAP-20.md) | **实现者的入口。** 服务身份与清单：服务 = 电路，`.well-known/tapeapi.json`，持有人 EIP-712 委托，解析算法。Service identity and manifest. |
| [`spec/TAP-21.md`](../spec/TAP-21.md) | 签名响应信封、规范 JSON、错误码。Signed response envelope, canonical JSON, error codes. |
| [`spec/TAP-22.md`](../spec/TAP-22.md) | 计量支付：累计凭证、托管合约、无强制协议费（默认 1% 维护贡献，提供者可设为 0）。Metered payment. |
| [`spec/TAP-23.md`](../spec/TAP-23.md) | 块锚定的跨链读取。Attested Read. |
| [`spec/TAP-24.md`](../spec/TAP-24.md) | 无桥跨链兑换（已撤回）。Intent RFQ (withdrawn). |
| [`spec/TAP-25.md`](../spec/TAP-25.md) | 链上 `eval()` 裁决的方法。Circuit-Verified Methods. |
| [`spec/TAP-26.md`](../spec/TAP-26.md) | **Tape Channel：** 两个容器之间的端到端加密通道（持有人授权的通道密钥、收件房间、中继 / ChannelBus / TapeSend）。Private channels between containers. |
| [`spec/TAP-27.md`](../spec/TAP-27.md) | **Tape Group：** 至多 32 个容器的加密群聊（实验性的格式 2 最多 128 个；群主管理的纪元、加密名单、发送者签名）。Private groups of up to 32 containers (up to 128 in the experimental format 2). |
| [`spec/vectors/`](../spec/vectors/) | 测试向量与独立的 Python 实现 `verify.py`。Test vectors and an independent Python implementation. |

## 设计与说明 / Design and explainers

| 文件 | 是什么 / What |
|---|---|
| [`DESIGN.md`](../DESIGN.md) | 设计契约：外部合约地址、身份模型、信封、凭证、合约接口。The design contract. |
| [`docs/FEES.md`](FEES.md) | 费用模型：无强制协议费；默认 1% 维护贡献，提供者可设为 0；运营方没有费率开关。Fees. |
| [`BUSINESS.md`](../BUSINESS.md) | 收入模型与我们在协议里的位置。How TapeAPI makes money. |
| [`docs/CROSSCHAIN.md`](CROSSCHAIN.md) | 跨链、流动性、可验证计算；TAP-23/24/25 的动机。Cross-chain rationale. |
| [`docs/CHEAPEST-CIRCUIT.md`](CHEAPEST-CIRCUIT.md) | 最便宜拿到"电路 + 已激活容器"的实测路径。Getting a circuit cheaply. |
| [`docs/ROADMAP.md`](ROADMAP.md) | 路线图：现在、接下来、更远，以及不会做的事。Roadmap: now, next, later, and what we will not do. |
| [`docs/OPERATING.md`](OPERATING.md) | 运营者手册：密钥、监控、计量、RPC、限流、中继容量。Running a service or relay. |
| [`docs/REVIEW-v0.2.md`](REVIEW-v0.2.md) | v0.1 → v0.2 复盘：哪里错了、为什么改。Why the design is what it is. |

## 代码 / Code

| 目录 | 是什么 / What |
|---|---|
| [`sdk/`](../sdk/) | `@tapeapi/sdk`：解析、调用、付费、通道、群聊。The client SDK. |
| [`server/`](../server/) | `@tapeapi/server`：提供者运行时（Node 与 Fetch API）。The provider runtime. |
| [`contracts/`](../contracts/) | Solidity + Foundry：ServiceDirectory、TapeAPIEscrow、ChannelBus。 |
| [`examples/`](../examples/) | 可运行示例，包括中继服务与 Cloudflare Worker。Runnable examples. |
| [`conformance/`](../conformance/) | 黑盒一致性测试，任何实现都能跑。A black-box conformance suite. |

变更记录 / Changelog: [`CHANGELOG.md`](../CHANGELOG.md).
