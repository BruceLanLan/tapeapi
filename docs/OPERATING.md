# 运营 TapeAPI 服务与中继 / Operating a TapeAPI service or relay

> 给运行提供者（`@tapeapi/server`）或中继（`examples/relay-service`、`examples/cloudflare-worker`）的人。
> For whoever runs a provider or a relay. Every number below is the reference implementation's default, read from the code.

## 1. 密钥：每一把是什么、丢了会怎样 / Keys and their blast radius

| 密钥 / Key | 谁持有 | 用来做什么 | 泄露的后果 | 放在哪里 | 怎么轮换 |
|---|---|---|---|---|---|
| 电路持有人钱包 / circuit holder | 你本人（硬件钱包或 Safe） | 签委托（TAP-20）、签通道记录（TAP-26）、写站点 | 服务与通道身份全部可被冒用；可转走电路 | **只在钱包里**，从不进服务器 | 电路本身不轮换；转手即换人 |
| 签名者 `SIGNER_KEY` | 服务进程 | 签每个响应（TAP-21） | 在委托到期前可伪造你服务的响应 | 服务器环境变量 / Worker secret | 生成新密钥 → 持有人签新委托 → 更新清单 → 重启；旧委托到期前仍有效，所以委托期别太长 |
| 结算者 `SETTLER_KEY` | 结算循环 | 付 gas 把凭证结算上链（TAP-22） | 只能偷走它自己钱包里的 BNB（钱进的是提供者账户，不进结算者） | 服务器环境变量；钱包里只放够几天 gas 的 BNB | 换新地址，转入少量 BNB |
| 通道身份 `identity.json` | 应用 | TAP-26/27 的 X25519 + Ed25519 | 在记录到期或被替换前可冒充该容器开新通道、在群里发言 | 权限 600 的文件；`scripts/channel-keys.mjs` 生成 | 生成新身份 → 持有人签新记录（`issued` 更大）→ 发布；客户端会拒绝更旧的记录 |
| ChannelBus 发送密钥 | 应用 | 往总线发帧时付 gas | 只有它钱包里的 BNB；发送地址与资金来源在链上永久公开 | 专用、只放少量 BNB | 随时换 |

**规则：** 持有人钱包永远不在服务器上。委托和通道记录的有效期都建议 ≤ 90 天，并按期续签（运行时在委托剩余不足 7 天时会在日志里提醒）。

## 2. 要盯的指标 / What to monitor

`provider.stats()`（Node 与 Worker 同一份）与 `GET /tapeapi/v1/health`：

| 字段 | 含义 | 告警条件 |
|---|---|---|
| `health.ok` | 委托是否仍有效 | **为 `false` 立即处理**：之后的调用一律回未签名的 503 `DELEGATION_INVALID` |
| `delegationExpires` | 委托到期时间（Unix 秒） | 距现在 < 7 天 |
| `delegationLapsed` | 因委托过期被拒的调用数 | > 0 |
| `singleInstance` | 计量存储没有原子 `advance()` | 为 `true` 且跑了多个实例（会重复服务同一凭证） |
| `failed`、`byCode` | 失败调用及按错误码分布 | `INTERNAL` 持续上升；`BAD_VOUCHER` 突增（价格或清单不一致） |
| `rateLimited` | 被限流的请求数 | 突增（被刷或额度太紧） |
| `uptimeS` | 运行时长 | 频繁归零（进程在重启） |

结算循环（`createSettler(...).stats()`）：`settled`、`failed`、`lastRun`。**`lastRun` 超过两个周期没更新，或 `failed` 连续增长，就要看日志。** 另外单独监控结算者钱包的 BNB 余额：余额不够付 gas 时，消费者的提现请求到期前没结算的收入就收不回来了（TAP-22 §3.3.1 的 48 小时窗口）。

## 3. 计量存储与多实例 / The meter

- **内存计量**（默认）：进程一停，未结算凭证全部丢失；多实例各记各的，会重复服务同一张凭证。收费服务用它会在启动时警告。
- **单进程 Node：** 设 `METER_FILE=/path/meter.json`（`examples/_lib/store.mjs`，先写临时文件再重命名）。只能一个进程用这个文件。
- **Cloudflare / 多实例：** 用 D1（`examples/cloudflare-worker/d1-store.js`，一条条件 `UPDATE` 实现原子比较并设置）。收费中继没有 D1 绑定会**拒绝启动**。
- 备份：计量文件或 D1 就是你的应收账款。定期备份，结算完的行可以清理。

## 4. RPC 节点 / RPC nodes

- 读取要求**参与回答的节点全部一致**（不是多数）。节点数等于一致要求时，任何一个节点故障都会让读取失败，运行时会警告。
- 示例与 Worker 默认 3 选 2，三家运营方：`https://bsc-dataseed.bnbchain.org,https://bsc-dataseed1.defibit.io,https://bsc-dataseed1.ninicoin.io`。
  `bsc-rpc.publicnode.com` 在 2026-09-27 对每个请求都超时，已移出默认列表。
- `bsc-dataseed*` 不支持 `eth_getLogs`，默认列表因此读不了 ChannelBus。读 ChannelBus 用 SDK 的 `BUS_RPC_URLS`（48 Club `rpc-bsc.48.club` 与 1RPC `1rpc.io/bnb` 提供日志，2026-09-27 实测至少保留 500,000 个区块；再加一个 dataseed 提供回执），单独建客户端，`timeoutMs` 15000。
  Reading ChannelBus: use the SDK's `BUS_RPC_URLS` (48 Club and 1RPC serve logs, at least 500,000 blocks back, measured 2026-09-27) in a client of its own. publicnode keeps only 5,000 to 10,000 blocks of logs when it is up.SDK 会在读取范围超出节点保留期时警告一次。中继传输不依赖 `eth_getLogs`。

## 5. 限流默认值 / Rate limits

提供者运行时（每 60 秒窗口）：每个 IP 免费调用 600 次；每个经签名证明的消费者付费调用 6,000 次；每个 IP 合计 6,600 次。
被限流的请求在读取请求体、签名之前就被拒绝，回未签名的 429 与 `retry-after`。NAT 后面的很多用户共享一个 IP，额度偏紧时调大 `rateLimit.free`。

## 6. 中继的容量与成本 / Relay capacity and cost

参考中继（`relay-core.mjs`）的上限：

| 项 | 默认 |
|---|---|
| 房间数 | 10,000 |
| 每房间普通帧 | 256（满了丢最旧的） |
| 每房间邀请 / 纪元消息（0x03 / 0x04，普通帧挤不掉） | 64；每个来源每 10 分钟最多 8 条 |
| 单帧大小 | 22,000 个 base64 字符（约 16 KiB） |
| 同时挂起的长轮询 | 5,000 |
| 房间空闲寿命 | 15 分钟 |
| 免费握手：每房间条数 / 房间数 / 寿命 / 帧大小 | 8 / 1,000 / 10 分钟 / 2,048 字符 |
| 长轮询最长等待 | 20 秒（低于运行时 25 秒的处理超时） |

- **Node 中继**的内存上限大约是 房间数 × 每房间帧数 × 帧大小；默认值下最坏情况是 GB 级，按机器内存调小 `maxRooms` 或 `maxFramesPerRoom`。
- **Cloudflare 中继**每个房间一个 Durable Object：每个新房间名都是一个新的计费对象，长轮询按对象的挂起时长计费。
  默认每个 IP 每分钟最多开 60 个新房间（`RATE_NEW_ROOMS`；注意这是每个实例各自计，不是全局）。房间清空后由定时器清理并停止计费。
  `RELAY_SWEEP_MS` / `RELAY_ROOM_TTL_MS` 只给本地测试用，生产环境不要设置。
- 本地实测：`node examples/cloudflare-worker/smoke-local.mjs`（需要 wrangler，不属于 `npm test`）。

## 7. 上线前检查清单 / Before going live

1. 持有人签了委托，`delegationExpires` 在 30 到 90 天后；清单已通过 `api.tx.publishManifest` 写入站点。
2. 收费服务：计量是持久的（`METER_FILE` 或 D1），结算循环在跑（`SETTLER_KEY`），结算者钱包有 BNB。
3. RPC 至少 3 个节点、来自至少 2 个运营方；读 ChannelBus 的节点支持 `eth_getLogs`。
4. 监控了 §2 的告警条件和结算者余额。
5. 用 SDK 从另一台机器解析一次你的容器并调用一次，确认签名能验证通过。
