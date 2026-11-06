# 应用与容器之间的互通（实验性）

两个本地演示和一个实验性的包，展示一个 TapeOut 应用或容器怎样调用另一个、并自己核对回答。**这里的一切都是实验性的**：
不受兼容承诺约束，任何次版本都可能改动或移除。示例只在 SDK 的假链上和测试里运行，不在 npm 包里。

> 任何跨应用调用都是链下请求，站点因此不再是"100% 链上"；授权与撤销由被调用方执行，合约层到来前只约束读到它的人，对恶意服务无效；
> 回执证明对方签了什么，不证明数据正确，也不证明上游模型；外壳把关之前用户要自己比对钱包里"请求来自"与授权里的调用方名字；授权书不含任何
> 付款；付费调用依赖的托管合约未审计、未部署，主网不可用；访客授权今天没有任何 TAP，这是原型；TAP-11、TAP-13、TAP-14 至 TAP-18 已合并为 Draft（合并不等于
> 被采纳）。

## 1. 容器对容器：只用现有 API

[`examples/container-interop/`](../../../examples/container-interop/) 只用 SDK 已有的东西（没有新格式）：

- **(a) 在授权书上限内付费调用**：容器 A 的代理用会话钥匙调用容器 B 的收费方法，超过上限的调用被拒。背后的托管合约未审计、未部署。
- **(b) 任务线程**：两个容器之间的报价、接单、交付与裁决，加上 A 自己的验收核对（签名有效的交付里也可能有错的数字，只有 A 的核对能发现）。
- **(c) 私密通道**：经只存密文的中继收发加密消息，以及对一次请求的签名回执。

```bash
node examples/container-interop/run.mjs all
```

它的 README 末尾有一张缺口表：今天容器还分辨不了、拒绝不了、撤销不了的事。

## 2. 应用对应用：访客授权（原型）

[`examples/app-interop/`](../../../examples/app-interop/) 里有两个应用：A 按名字找到 B，从链上读 B 的清单，调用一个免费方法和一个收费方法，
并核对每个回答。实验性的包 `@tapeapi/interop`（独立的包，不属于 SDK）增加了**访客授权**：访客的钱包按 EIP-712 签名（独立的域 "TapeAPI Visitor Grant"，
不是 TAP-11 的域），允许应用 A 在短时间内（默认 1 小时，最长 7 天）、有限次数地调用服务 B 的几个指定方法。第一个字段是由其它字段生成的
一句人话。

- A 在请求顶层加 `grant`，附上用它的一次性钥匙签的调用证明（`withGrant`）。
- B 按固定顺序核验，便宜的在前、读链的在后（`verifyVisitorGrant`、`grantMethods`），计数，接受撤销（免费方法 `grant_revoke`），并在签名
  回答里写入 `result.grant`。
- 拒绝一律是 `BAD_REQUEST`，message 前缀 `grant: <原因>`，不带 `error.data`。
- 回答丢失后用同一个 id 重试：只要 B 还保留着，就原样拿到 B 第一次签好的信封，逐字节相同（服务端实验性的 `ctx.onSigned` / `ctx.resend`）；
  否则答 `grant: replayed`。
- 自测向量：`spec/vectors/interop-visitor-grant.json`，由 `spec/vectors/verify.py` 复算。
- 格式说明，供独立实现 B 一侧的核验：[TAPI-28](../../../spec/TAPI-28.md)（实验性，不是 TAP，任何次版本都可能改动；以代码为准）。

```bash
node examples/app-interop/demo.mjs
node --test examples/app-interop/*.test.mjs
```

钱包怎样显示这份授权**还没有实测**。实测用的本机测试页在
[`examples/app-interop/wallet-render/`](../../../examples/app-interop/wallet-render/)（空钱包、不发交易，页面不向任何地方发送数据）。

## 它不是什么

- 不是登录、账户，也不是任何形式的凭据。
- 不是 TAP，也不是其它服务认识的格式。
- 不进首页、目录和调试台。
- 这里没有任何东西付款，也没有任何东西能在主网上带着钱使用。
