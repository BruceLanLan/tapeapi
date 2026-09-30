# TapeAPI provider conformance suite

A black-box test suite for **any** TapeAPI provider (TAPI-20 / TAPI-21 / TAPI-22). You give it a URL; it knows
nothing about how the provider is built. Only crypto primitives are imported from `sdk/src` (canonical JSON,
digests, secp256k1). The reference provider runtime is not used.

## Run it against your provider

Needs Node ≥ 20 and this repo checked out, with `npm install` already run at the repo root.

```sh
# Free-method, envelope, malformed-request and HTTP checks
node conformance/run.mjs --url https://api.example.com

# Plus TAPI-22 voucher checks. Use a funded test consumer, or a session key authorised on YOUR channel
node conformance/run.mjs --url https://api.example.com \
  --paid-method circuitHolder --consumer-key 0x<test consumer key> --session-key 0x<session key>

# Plus the rate-limit check. Run this against an instance nobody else is using: it burns your budget for one window
node conformance/run.mjs --url http://127.0.0.1:8787 --check-rate-limit 600 --junit conformance.xml
```

Check the public service with the example arguments its methods need / 用公共服务方法所需的示例参数检查它：

```bash
node conformance/run.mjs --url https://api.tapeapi.fun --params examples/public-api/conformance-params.json
```

| Option | Meaning |
|---|---|
| `--manifest file.json` | Trusted manifest (the one you resolved on chain). Without it the suite trusts the served `/.well-known/tapeapi.json` |
| `--params file.json` | `{ "<method>": { ...params } }` for methods that need arguments (default `{}`) |
| `--paid-method`, `--consumer-key`, `--session-key`, `--chain-id` | Turn on the TAPI-22 checks. Keys stay on your machine. Only the vouchers they sign are sent |
| `--check-rate-limit N` | Send N+5 rapid free calls. Any 429 must be unsigned and carry `Retry-After` and `RATE_LIMITED` |
| `--body-limit BYTES` | Your request-body limit. By default the suite sends 1 MiB + 1 |
| `--junit out.xml`, `--json out.json` | Machine-readable output |
| `--strict` | SHOULD failures also fail the run |
| `--quiet` | Print only the checks that did not pass |

**Exit code:** 0 when every MUST check passes, 1 when any MUST fails, 2 on a usage or configuration error.
In JUnit output, MUST failures are `<failure>`. SHOULD failures and not-applicable checks are `<skipped>` unless
you pass `--strict`, so the CI colour matches the exit code.

**Is it safe to run with real keys?** Use a dedicated test consumer with a small channel anyway. The suite
always sends a voucher for cumulative `0`, which is at or below `claimedOf` and so can never settle. It signs
`lastCumulative + price − 1` only when the provider's `lastCumulative` is proven: either it is `0`, or it comes
with an attached voucher that recovers to your own key. An unproven figure is refused, because signing above a
number the provider names is the channel-drain attack described in TAPI-22 §3.2.

**Trust.** Without `--manifest`, the suite accepts the provider's self-reported `signer` and `container`, so it
can only test that the provider is consistent with itself. TAPI-20 clients MUST NOT trust a self-reported
container. For a real audit, pass the manifest you resolved on chain.

Every check carries its id, level and spec citation in the report; the list is in [`run.mjs`](run.mjs) and [`relay.mjs`](relay.mjs).

**Self-test:** `node --test conformance/selftest.test.mjs` runs the suite against the reference provider, which
must pass every MUST. It also runs it against six deliberately broken providers, each of which must fail on the check
that names its defect, and against one hostile provider, which must not get a voucher above 0 signed.

## Relay suite (TAPI-26 §3.5)

A relay is itself a TapeAPI service, so `relay.mjs` tests one the same way: by URL, black-box. Every `relaySend`,
`relayHandshake` and `relayRecv` answer goes through the same envelope checks as the provider suite (`lib.mjs`):
signed by the manifest signer and bound to our request. On top of that it checks the relay profile. Run
`run.mjs` against the same URL as well for the generic TAPI-20 / TAPI-21 checks.

```sh
node conformance/relay.mjs --url https://relay.example.com
node conformance/relay.mjs --url http://127.0.0.1:8788 --max-frame-b64 22000 --handshake-b64 2048 --room-frames 256 \
  --check-rate-limit 600 --junit relay.xml --json relay.json
```

It takes the same `--manifest`, `--live`, `--junit`, `--json`, `--strict`, `--quiet`, `--max-skew`, `--timeout-ms` and
`--check-rate-limit` options, and uses the same exit codes. Relay-specific options:

| Option | Meaning |
|---|---|
| `--max-frame-b64 N` | Your frame cap in base64 characters. Stating it makes `send.oversize` a MUST. Without it the suite probes at the reference 22,000 and reports only a SHOULD |
| `--handshake-b64 N` | Your `relayHandshake` frame cap. Same rule, reference 2,048 |
| `--room-frames N` | Your per-room frame bound. The flood that must not evict `0x03` / `0x04` is N + 44 frames. Default 256 |
| `--full-wait-ms MS`, `--poll-timeout-ms MS` | `waitMs` of the full-length poll (default 60,000) and the client deadline for it (default 90,000) |
| `--max-retry-wait S` | A 429 is waited out (Retry-After) and retried, up to this many seconds. Default 120. Every 429 seen is checked against TAPI-21 §3.4 |

**Price.** A relay whose `relaySend` has a price above 0 is detected from the manifest. The checks that need
many posts (frame and answer size, the protected ring, the per-source cap) are then skipped with that reason. The suite
never pays. Everything else still runs, with rooms filled through the free `relayHandshake` path.

**What it leaves behind.** A few hundred small frames and about 60 frames of 16 KiB, in random rooms. The relay
expires them like any other room.

| Check id | Level | TAPI-26 §3.5 clause |
|---|---|---|
| `tapi26.relay.manifest.methods` / `.handshake-free` / `.recv-free` | MUST | method table: three methods; `relayHandshake` MUST be 0; `relayRecv` 0 |
| `tapi26.relay.post.result-shape` / `tapi26.relay.recv.result-shape` | MUST | method table: `{ i, epoch }` and `{ frames: [{ i, frame }], next, epoch }` |
| `tapi26.relay.recv.unknown-room` | MUST | Epoch: `null` from `relayRecv` for a room that does not exist, with no frames |
| `tapi26.relay.recv.no-create` | MUST | Rooms: only a post creates a room |
| `tapi26.relay.recv.next` | MUST | `next`: the last returned `i`, or `after` unchanged when nothing was returned |
| `tapi26.relay.epoch.format` / `.every-method` / `.random` | MUST | Epoch: matches `^[0-9a-f]{1,32}$`, returned by every method, random per room |
| `tapi26.relay.epoch.length` | SHOULD | Epoch: RECOMMENDED 8 bytes |
| `tapi26.relay.epoch.mismatch-resets` | MUST | Epoch: a different epoch is answered as if `after` were −1 |
| `tapi26.relay.index.increasing` | MUST | `i` strictly increasing within a room |
| `tapi26.relay.recv.order` / `.content` / `.after` | MUST | frames with `i > after`, in posting order, as posted |
| `tapi26.relay.envelope.bound` | MUST | the delivery claim is signed: a `relayRecv` answer does not verify for another room or cursor (TAPI-21 §3.3) |
| `tapi26.relay.request.bad-params` | SHOULD | malformed `room` / `after` / `waitMs` / `epoch` / `frame` refused as `BAD_REQUEST` (TAPI-21 §3.2) |
| `tapi26.relay.send.max-wire` | SHOULD | the frame cap holds the largest wire message (16,448 bytes) |
| `tapi26.relay.send.oversize` (+ `.code`) | SHOULD, MUST with `--max-frame-b64` | a relay caps the size of a frame; refused as `BAD_REQUEST` |
| `tapi26.relay.recv.fits-cap` / `.progress` / `.paging-order` | MUST | an answer MUST fit 1 MiB; at least one frame per page; paging never skips (only the oldest MAY be dropped) |
| `tapi26.relay.longpoll.bounded` | MUST | MAY hold for **up to** `waitMs` |
| `tapi26.relay.longpoll.holds` / `.wakes` | SHOULD | holds an empty poll; answers as soon as a frame arrives |
| `tapi26.relay.longpoll.full-length` | MUST | `waitMs` capped below the relay's deadline, so a full-length poll is an empty answer, never `INTERNAL` |
| `tapi26.relay.handshake.accept` | MUST | `relayHandshake` carries `0x01` + `{ t: accept \| ready }` |
| `tapi26.relay.handshake.no-payment` | MUST | a priced relay MUST carry the handshake for free (priced relays only) |
| `tapi26.relay.handshake.refuse-other` (+ `.refuse-code`) | MUST (code SHOULD) | the relay refuses anything else: `0x02`–`0x04`, another `t`, non-JSON, bad UTF-8 |
| `tapi26.relay.handshake.size` | SHOULD, MUST with `--handshake-b64` | the handshake frame is small |
| `tapi26.relay.handshake.room-limit` | SHOULD | MAY refuse more than N per room; when it does, a caller error. Skipped when there is no limit |
| `tapi26.relay.kept.survives-flood` / `.order` | MUST | `0x03` / `0x04` held under their own bound that frames cannot evict; one index sequence in posting order. Skipped if the flood evicted nothing |
| `tapi26.relay.kept.source-cap` | SHOULD | cap `0x03` / `0x04` per room per source, refused as `BAD_REQUEST` |
| `tapi21.envelope.*`, `tapi21.ratelimit.*`, `tapi21.response.size-cap` | as in the provider suite | every answer; every 429 seen |

Some MUSTs rest on a normative statement with no RFC 2119 keyword: a method-table entry, or the definition of `i`,
`after` and `next`. A relay that breaks one of these breaks every client, so the suite treats them as MUST.

**Self-test:** `node --test conformance/relay-selftest.test.mjs` runs the suite against the reference relay
(`examples/relay-service/relay-core.mjs` under the reference server), both free and priced. The relay must pass
every MUST and every SHOULD. A third run puts the relay behind a rate limit, and the suite must wait out and check
each 429. The test then runs eight deliberately broken relays, each of which must fail on the check that names its
defect:

- frames returned newest-first
- no epoch in post answers
- a stale epoch ignored
- `relayHandshake` carrying anything
- the whole backlog returned in one answer
- a `waitMs` cap above the handler deadline
- invites evicted by a flood
- an epoch invented for an unknown room

---

# TapeAPI 提供者一致性测试套件

一套黑盒测试，适用于**任何** TapeAPI 提供者（TAPI-20 / TAPI-21 / TAPI-22）。你只需给出 URL，套件完全不关心提供者是怎么实现的。它只从 `sdk/src` 导入密码学原语（规范 JSON、摘要、secp256k1），不使用参考提供者的运行时。

## 对你的提供者运行

需要 Node ≥ 20，并已检出本仓库、在仓库根目录执行过 `npm install`。

```sh
node conformance/run.mjs --url https://api.example.com                       # 免费方法、信封、畸形请求、HTTP 检查
node conformance/run.mjs --url https://api.example.com \
  --paid-method circuitHolder --consumer-key 0x<测试消费者私钥> --session-key 0x<会话私钥>   # 加上 TAPI-22 凭证检查
node conformance/run.mjs --url http://127.0.0.1:8787 --check-rate-limit 600 --junit conformance.xml  # 加上限流检查（请用无人使用的实例）
```

- **退出码**：全部 MUST 通过为 0；任一 MUST 失败为 1；用法或配置错误为 2。JUnit 中 MUST 失败记为 `<failure>`。SHOULD 失败与不适用项记为 `<skipped>`，加 `--strict` 时 SHOULD 失败也记为 `<failure>`。
- **用真实私钥安全吗？** 仍建议使用小额通道的专用测试消费者。套件总会发送 cumulative `0` 的凭证，它必然不高于 `claimedOf`，永远无法结算。只有当提供者报告的 `lastCumulative` 为 `0`，或附带的凭证能恢复出你自己的密钥时，套件才会签 `lastCumulative + price − 1`。对未经证明的数字一律拒签，因为那正是 TAPI-22 §3.2 描述的通道掏空攻击。私钥不会离开本机。
- **信任**：不给 `--manifest` 时，套件信任提供者自报的 `signer` 与 `container`，只能检验它自身是否一致（TAPI-20 规定客户端 MUST NOT 信任自报容器）。正式审计请传入从链上解析得到的清单。
- 每项检查在报告里都带 id、级别与规范出处；完整列表见 [`run.mjs`](run.mjs) 与 [`relay.mjs`](relay.mjs)。
- **自测**：`node --test conformance/selftest.test.mjs`。参考提供者须通过全部 MUST。六个故意做坏的提供者必须各自失败在点名其缺陷的那一项上；对一个恶意提供者，套件不得签出高于 0 的凭证。

## 中继套件（TAPI-26 §3.5）

中继本身就是 TapeAPI 服务，所以 `relay.mjs` 用同样的方式测试它：给 URL，黑盒。`relaySend`、`relayHandshake`、`relayRecv` 的每个回答都经过与提供者套件相同的信封检查（`lib.mjs`），即由清单签名者签名并绑定到我们的请求。在此之上再检查中继配置。通用的 TAPI-20 / TAPI-21 检查请另对同一 URL 运行 `run.mjs`。

```sh
node conformance/relay.mjs --url https://relay.example.com
node conformance/relay.mjs --url http://127.0.0.1:8788 --max-frame-b64 22000 --handshake-b64 2048 --room-frames 256 \
  --check-rate-limit 600 --junit relay.xml --json relay.json
```

- **选项与退出码**：与 `run.mjs` 相同（`--manifest`、`--live`、`--junit`、`--json`、`--strict`、`--quiet`、`--max-skew`、`--timeout-ms`、`--check-rate-limit`）。中继专用选项如下：
  - `--max-frame-b64 N`：你的帧上限（base64 字符数）。声明后 `send.oversize` 按 MUST 判定；不声明时按参考值 22,000 探测，只按 SHOULD 判定。
  - `--handshake-b64 N`：`relayHandshake` 的帧上限。规则同上，参考值 2,048。
  - `--room-frames N`：每个房间的帧数上限。不得挤掉 `0x03` / `0x04` 的洪泛为 N + 44 帧，默认 256。
  - `--full-wait-ms`：满时长轮询的 `waitMs`，默认 60,000。`--poll-timeout-ms`：它的客户端时限，默认 90,000。
  - `--max-retry-wait S`：遇到 429 时按 Retry-After 等待后重试，最多等这么多秒，默认 120。见到的每个 429 都按 TAPI-21 §3.4 检查。
- **价格**：套件从清单识别 `relaySend` 价格大于 0 的中继。此时需要大量投递的检查（帧与回答大小、受保护环、每来源上限）会跳过，并写明原因。套件从不付费，其余检查仍经免费的 `relayHandshake` 通道执行。
- **遗留**：随机房间里几百个小帧与约 60 个 16 KiB 的帧，中继会像对待其他房间一样让它们过期。
- **检查项**：id、级别与 §3.5 出处见上方英文表格（英文为准）。部分 MUST 出自没有 RFC 2119 关键词的规范性陈述，例如方法表条目，以及 `i`、`after`、`next` 的定义。违反它们会让所有客户端出错，所以套件按 MUST 判定。
- **自测**：`node --test conformance/relay-selftest.test.mjs`。测试对象是参考中继（参考服务器上的 `examples/relay-service/relay-core.mjs`），免费与收费各测一遍，须通过全部 MUST 与 SHOULD。第三次运行给中继加上限流，套件须等过并检查每个 429。之后是八个故意做坏的中继，每个都必须失败在点名其缺陷的那一项上：
  - 帧按新到旧返回
  - 投递回答缺纪元
  - 忽略过期纪元
  - `relayHandshake` 什么都收
  - 一次返回全部积压
  - `waitMs` 上限高于处理时限
  - 洪泛挤掉邀请
  - 为不存在的房间编造纪元
