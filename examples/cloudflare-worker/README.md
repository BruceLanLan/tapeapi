# TapeAPI provider on Cloudflare Workers / 在 Cloudflare Workers 上跑一个 TapeAPI 提供者

Free TLS, a global edge, built-in DDoS protection and a hostname you control, which is everything a TapeAPI
provider needs that the protocol itself does not supply.
免费 TLS、全球边缘、自带抗 DDoS，以及一个你控制的主机名 —— 这些正是协议本身不提供、而提供者必需的东西。

## Why its own Worker and its own hostname / 为什么要独立的 Worker 和独立主机名

**Placement.** Smart Placement pins a Worker near its D1 database rather than at the edge nearest the caller.
That is correct for a database-heavy app and wrong for a signing API, whose free path touches no database at all.
A provider sharing a Smart-Placed Worker inherits that detour for nothing.
**放置策略。** Smart Placement 把 Worker 固定在靠近 D1 的位置，而不是离调用方最近的边缘。那对重度依赖数据库的
应用是对的，对一个免费路径完全不碰数据库的签名 API 是错的；挤进去只会白白多绕一程。

**The hostname is on chain.** `endpoints.live` lives inside the manifest stored in your container's site, so
moving hosts later costs a `SiteRegistry.putFile` transaction. A subdomain you own can be repointed for free;
a path on somebody else's site cannot.
**主机名会上链。** `endpoints.live` 写在存于容器站点的清单里，以后搬家要花一笔 `putFile` 交易。
自己的子域名可以免费改指向，别人站点上的一条路径不行。

## Steps / 步骤

**From a phone, no computer:** the holder console at `https://tapeapi.fun/console/` (source `site/console/`) does steps
2, 3 and 5 below from a wallet's in-app browser, and Cloudflare Workers Builds deploys this Worker from the repository
(build `npm ci`, deploy `npm run deploy:provider`, which pins the wrangler version in package.json). Until the delegation is set
the Worker is in setup mode: it answers only `/tapeapi/v1/health`, naming the signer address derived from `SIGNER_KEY`.
**只用手机：** 持有人操作台（`site/console/`）在钱包内置浏览器里完成下面第 2、3、5 步；Cloudflare Workers Builds 从仓库部署
本 Worker。委托设好之前 Worker 处于设置模式，只回答健康检查，其中给出由 `SIGNER_KEY` 推导的签名地址。

1. Mint a circuit and open its container (about 0.015 BNB in total; see `docs/CHEAPEST-CIRCUIT.md`). A container that
   is not opened has no code, and SiteRegistry refuses its files even from the holder.
   铸造一枚电路并开通容器（总共约 0.015 BNB）。没开通的容器没有代码，SiteRegistry 连持有人写文件也会拒绝。
2. Generate a hot signing key and have the circuit holder sign a delegation for it:
   生成一把热签名密钥，由电路持有人为它签一份委托：
   ```
   HOLDER_KEY=0x... node examples/reader-service/sign-delegation.mjs \
     --container 0x<container> --signer 0x<signer> --expires $(( $(date +%s) + 30*86400 ))
   ```
3. Set the variables. `SIGNER_KEY` is the only secret; `CIRCUITS`, `TOKEN_ID`, `CONTAINER`, `DELEGATION_EXPIRES` and
   `DELEGATION_SIG` are public (they end up in the manifest) and can be plain dashboard variables, which `keep_vars`
   keeps across deploys. `SIGNER_ADDRESS` is optional: if set, it must match the key. Text pasted with a trailing space
   or newline is trimmed.
   设置变量。只有 `SIGNER_KEY` 是机密；其余五个是公开的（最终写进清单），设为后台普通变量即可，`keep_vars` 让它们在部署之间保留。
   `SIGNER_ADDRESS` 可选，设了就必须与密钥一致。粘贴时带的首尾空白会被去掉。
   ```
   npx --yes wrangler@4.141.0 secret put SIGNER_KEY -c examples/cloudflare-worker/wrangler.toml
   npx --yes wrangler@4.141.0 deploy -c examples/cloudflare-worker/wrangler.toml \
     --var CIRCUITS:0x<circuits> --var TOKEN_ID:<id> --var CONTAINER:0x<container> \
     --var DELEGATION_EXPIRES:<unix seconds> --var DELEGATION_SIG:0x<65-byte signature>
   ```
4. Point the custom domain at the Worker and check it answers:
   把自定义域名指向这个 Worker，然后确认它有回应：
   ```
   curl https://api.tapeapi.fun/tapeapi/v1/health
   curl -X POST https://api.tapeapi.fun/tapeapi/v1/blockNumber \
     -H 'content-type: application/json' -d '{"id":"1","params":{}}'
   ```
5. Publish the manifest into the container's site. `api.tx.publishManifest({ container, manifest })` returns the
   `putFile` / `appendChunk` transactions for the holder to sign; the registry key is `.well-known/tapeapi.json`
   with **no leading slash**. Clients read the delegation from this on-chain copy, so renewing it means a new
   signature, new variables AND publishing again.
   把清单写进容器站点。`api.tx.publishManifest({ container, manifest })` 会给出持有人要签的交易；
   注册表键是 `.well-known/tapeapi.json`，**不带前导斜杠**。客户端读的是链上这份里的委托，所以续期要重新签名、更新变量，**并且再发布一次**。
6. From anywhere: `await api.resolve('0x<container>')` then `api.call(svc, 'blockNumber')`.
   然后在任何地方解析并调用即可。

## Paid methods / 收费方法

A free service needs no D1 and no contract of ours. The moment a method is priced, the meter must survive across
isolates: uncomment the `[[d1_databases]]` block and `d1-store.js` supplies `advance()`, a conditional
`UPDATE ... WHERE cumulative < ?` that SQLite evaluates as one statement. Two isolates racing the same voucher
then produce exactly one winner. Without it they lose each other's updates and one payment can buy several calls.
全免费的服务不需要 D1，也不需要我们的任何合约。一旦有方法收费，计量就必须跨隔离实例存活：取消注释
`[[d1_databases]]`，`d1-store.js` 提供的 `advance()` 是一条条件 UPDATE，由 SQLite 作为单条语句求值，
两个隔离实例争同一张凭证只会有一个赢家。没有它，它们会互相丢失更新，一次付款可能换到多次服务。

```sql
CREATE TABLE IF NOT EXISTS meter (
  consumer TEXT NOT NULL, provider TEXT NOT NULL,
  cumulative TEXT NOT NULL, expires INTEGER NOT NULL, sig TEXT NOT NULL,
  signer TEXT NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY (consumer, provider)
);
```

## Limits worth knowing / 值得知道的限制

- Rate-limit budgets are per isolate, not per service. Several isolates each get their own; Cloudflare's own
  rate limiting rules are the right place for a global cap.
  限流预算按隔离实例计，不按服务计。多个隔离实例各有一份；要全局上限请用 Cloudflare 自己的限流规则。
- `cf-connecting-ip` is set by the edge and a client cannot forge it. Behind any other proxy, pass `clientIp`
  yourself; never trust a client-settable header, or the limiter becomes a no-op.
  `cf-connecting-ip` 由边缘设置，客户端伪造不了。在其它代理之后请自己传 `clientIp`；
  绝不要信任客户端可自填的头，否则限流形同虚设。
- Keep the delegation fresh. The provider refuses to boot on an expired one, which on a Worker means every
  request fails: put its expiry in your calendar.
  让委托保持有效。提供者在委托过期时拒绝启动，在 Worker 上这意味着每个请求都失败；把到期日记进日历。

## relay.tape on Workers / 在 Workers 上跑 relay.tape

`relay-worker.js` + `wrangler-relay.toml` host the TAP-26 relay (`examples/relay-service/`) on its own Worker.
The TapeAPI side (identity, signed answers, metering, rate limits) runs in the Worker; **each room is a Durable
Object**. That is not an optimisation: Worker isolates share no memory, so rooms kept in the isolate would split
into several copies and a frame posted through one isolate would never reach a peer polling through another.
A Durable Object is one instance per name, globally, so every isolate sees the same room.
`relay-worker.js` 与 `wrangler-relay.toml` 把 TAP-26 中继放在独立 Worker 上。TapeAPI 那一面在 Worker 里，
**每个房间是一个 Durable Object**。这不是优化：隔离实例之间不共享内存，房间放在实例里会裂成好几份，
经由一个实例发出的帧到不了经由另一个实例轮询的对端。Durable Object 按名字全局唯一，所有实例看到同一个房间。

The relay is set up exactly like the provider (steps above): deploy it (`npm run deploy:relay`, or a Workers Build
with that deploy command), add the secret `SIGNER_KEY`, and let the holder console (steps 4 to 7, service URL
`https://relay.<your domain>`) show the variables to add and publish the manifest. Until then the relay answers only
its health, in setup mode. The identity is never written in `wrangler-relay.toml`, because a value there would
overwrite the dashboard's on every deploy.
中继的设置方式与服务完全相同：部署（`npm run deploy:relay`），添加密钥 `SIGNER_KEY`，再用持有人控制台第 4 到 7 步（服务网址
填 `https://relay.<你的域名>`）拿到要添加的变量并发布清单。在此之前中继处于设置模式。身份不写在 `wrangler-relay.toml` 里，
因为那里的值每次部署都会覆盖后台的值。

Frames are held in memory only; an evicted room loses them and TAP-26 receivers see the gap. The relay holds no
key and cannot read a byte of what it carries. `relay-worker.test.mjs` runs two isolates against one simulated
namespace, including a full TAP-26 channel with each side on a different isolate.
帧只在内存里；房间被回收时帧随之消失，TAP-26 接收方会看到空洞。中继没有任何密钥，读不了它搬运的任何一个字节。

A room expires on a Durable Object alarm, armed by a post and not re-armed once the room is empty. Each client IP
may create `RATE_NEW_ROOMS` (default 60) new rooms per minute **per isolate**; that is a cheap-flood guard, not a
global budget. A **priced** relay (`RELAY_PRICE_BEM` not `"0"`) needs the `[[d1_databases]]` block in
`wrangler-relay.toml`: `relay-worker.js` refuses to start one without it, because a meter in isolate memory serves
each voucher once per isolate.
房间由 Durable Object alarm 过期清理：投递时设置，房间空了就不再重设。每个客户端 IP 每分钟可新建 `RATE_NEW_ROOMS`（默认 60）
个房间，**按隔离实例计**：这是挡廉价洪水的，不是全局额度。**收费**中继（`RELAY_PRICE_BEM` 不为 `"0"`）需要
`wrangler-relay.toml` 里的 `[[d1_databases]]`：没有它 `relay-worker.js` 拒绝启动，因为放在实例内存里的计量会让每张凭证在每个实例各服务一次。

### Local smoke test on workerd / 在 workerd 上做本地冒烟测试

`npm test` runs the relay against in-process stand-ins for Durable Objects, alarms and D1. `smoke-local.mjs` runs
it on the real Workers runtime through `wrangler dev --local` (workerd + miniflare): real Durable Objects, real
alarms, a local D1. It deploys nothing, needs no login, and points RPC at dead local ports. It is **not** part of
`npm test`, because it fetches wrangler from npm the first time.
`npm test` 用进程内替身模拟 Durable Object、alarm 与 D1。`smoke-local.mjs` 经 `wrangler dev --local`（workerd + miniflare）
在真实 Workers 运行时上跑：真实的 Durable Object、真实的 alarm、本地 D1。不部署、不登录，RPC 指向本机死端口。
它**不属于** `npm test`，因为第一次要从 npm 取 wrangler。

```
node examples/cloudflare-worker/smoke-local.mjs                  # free, sweep, priced, priced-d1
node examples/cloudflare-worker/smoke-local.mjs free sweep       # a subset / 部分
```

| run | checks / 检查 |
|---|---|
| `free` | a 0x03 survives 300 0x02 frames posted after it; `RATE_NEW_ROOMS=3` refuses the 4th new room (also through `relayHandshake`) / 0x03 挺过其后的 300 个 0x02；第 4 个新房间被拒 |
| `sweep` | with `RELAY_SWEEP_MS=1000` and `RELAY_ROOM_TTL_MS=1500` the alarm removes a room while a long-poll holds its object alive, and an idle one / alarm 在长轮询让对象保持存活时删掉房间，空闲房间亦然 |
| `priced` | `RELAY_PRICE_BEM` set and no D1: every request is a 500 and the log names the missing `DB` / 无 D1：每个请求 500，日志指出缺少 `DB` |
| `priced-d1` | the same with a local D1 (dummy `database_id`, schema applied with `d1 execute --local`): boots, 402 without a voucher, handshake free / 带本地 D1：能启动，无凭证 402，握手免费 |

`RELAY_SWEEP_MS` and `RELAY_ROOM_TTL_MS` exist for this test only. Leave them unset in production: a room TTL
under 600 s drops an accept before the invite it answers has expired. Locally, miniflare passes a client-written
`cf-connecting-ip` through; Cloudflare's edge overwrites it, so the per-IP budgets are only as good as the edge.
`RELAY_SWEEP_MS` 与 `RELAY_ROOM_TTL_MS` 只为这个测试存在，生产环境不要设置：房间 TTL 低于 600 秒会在邀请过期前丢掉对它的 accept。
本地的 miniflare 会放行客户端自填的 `cf-connecting-ip`；Cloudflare 边缘会覆盖它，按 IP 的额度以边缘为准。
