# web2-adapter — 把现有 REST API 变成 TapeAPI 服务

**给谁**：已经有一个 REST API 和一套 API Key 的 Web2 公司（SaaS、数据商、AI 商）。
**做什么**：一个通用适配器。读 `adapter.config.json`，把每个 TapeAPI 方法映射到一个上游 HTTP 端点；
签名信封（TAP-21）、按次计费（TAP-22）、清单（TAP-20）全部由 `@tapeapi/server` 完成，公司只写配置。
上游 API Key 从环境变量注入（`${UPSTREAM_API_KEY}`），永远不会出现在清单或响应里。

自带的配置包了两个免 Key 的公开 JSON API：[frankfurter](https://frankfurter.dev)（汇率，`fxRate` 免费 / `fxConvert` 0.0001 BEM）
和 [Coinbase 公开价格接口](https://api.coinbase.com/v2/prices/BNB-USD/spot)（`spotPrice`、`cryptoRates`，免费；`spotPrice` 演示 URL 模板 `{pair}`，例如 `BNB-USD`）。

## 公司只需要写这 10 行

```json
"fxRate": {
  "priceBEM": "0",
  "url": "https://api.frankfurter.dev/v1/latest",
  "method": "GET",
  "headers": { "x-api-key": "${UPSTREAM_API_KEY}" },
  "params": { "from": "string", "to": "string" },
  "defaults": { "from": "USD", "to": "EUR" },
  "query": { "from": "from", "to": "to" },
  "pick": { "base": "base", "date": "date", "rates": "rates" }
}
```

字段：`url`（可含 `{param}` 路径模板）· `method` · `headers`（支持 `${ENV}`）· `priceBEM` · `params`/`returns`（写进清单的类型提示）·
`defaults` · `required` · `query`（查询参数 ← 方法参数）· `body`（POST JSON 字段 ← 方法参数，或 `"*"` = 只转发 `params` 里声明过的键）· `pick`（只返回挑出的字段，支持 `a.b.c`）。

安全边界（`adapter.mjs`，有测试 `adapter.test.mjs`）：`{param}` 值经 `encodeURIComponent`，且拒绝含 `/`、`\`、`..`、`?`、`#`、控制字符或单独 `.` 的值；
模板的静态前缀必须已是完整 origin + 路径（`{param}` 不能出现在主机部分），替换后再断言 `origin` 与路径前缀未变；
查询值只接受字符串/数字/布尔；上游头部只来自配置，调用方参数永远不进头部；上游 4xx/5xx 的正文只写日志，不回给调用者（`INTERNAL` 一律 `"internal error"`）。

## 三步运行

```sh
npm install --no-audit --no-fund            # 在 tapeapi/ 根目录，一次
node examples/web2-adapter/index.mjs        # :8788，临时 signer key
node examples/web2-adapter/consumer.mjs     # 另一个终端：解析 → 免费调用 → 付费调用演示
```

两条 curl：

```sh
curl -s -X POST http://127.0.0.1:8788/tapeapi/v1/fxRate -H 'content-type: application/json' -d '{"id":"1","params":{"to":"JPY"}}'
curl -s -X POST http://127.0.0.1:8788/tapeapi/v1/spotPrice -H 'content-type: application/json' -d '{"id":"2","params":{"pair":"BNB-USD"}}'
```

`consumer.mjs` 先 `api.resolve({ dev: url })`，再 `api.call(svc, 'fxRate')`（SDK 校验签名后才返回），
然后用随机 session key 生成一张 TAP-22 voucher 调 `fxConvert`。dev 模式下清单里的 escrow 是零地址占位，
provider 查不到链上余额/授权，所以付费调用会得到一个**签了名的错误信封**（`INTERNAL`），脚本会把 voucher 和信封原样打印并解释；
本地想把付费方法也跑通，启动 provider 时加 `FREE_ALL=1`（仅 dev 生效）。

## 从 dev 到主网

1. **铸电路**：在 TapeOut 铸一个电路 NFT，得到 `circuits`/`tokenId`；容器 = `DeWebHub.accountOf(circuits, tokenId)`。
2. **签委托**：`HOLDER_KEY=0x.. node examples/reader-service/sign-delegation.mjs --container 0x.. --signer <启动时打印的 signer> --expires .. --hub <DeWebHub>`，
   把输出的 `DELEGATION_SIG`/`DELEGATION_EXPIRES` 与 `CONTAINER`、`CIRCUITS`、`TOKEN_ID`、`ESCROW`、`PUBLIC_URL`、`SIGNER_KEY`、`UPSTREAM_API_KEY` 一起设进环境，重启（`dev` 变 `false`）。
3. **发布清单**：把 `GET /.well-known/tapeapi.json` 的内容写到容器 DeWEB 站点的 `/.well-known/tapeapi.json`。
4. **注册别名**：`api.tx.register({ circuits, tokenId, label: 'my-fx', manifestPath })` 发到 ServiceDirectory。

---

# web2-adapter — turn an existing REST API into a TapeAPI service

**For**: Web2 companies that already have a REST API and an API-key scheme.
**What**: a generic adapter. It reads `adapter.config.json`, maps each TapeAPI method to one upstream HTTP endpoint,
and lets `@tapeapi/server` do the signed envelopes (TAP-21), per-call metering (TAP-22) and the manifest (TAP-20).
The upstream API key comes from the environment (`${UPSTREAM_API_KEY}`) and never appears in the manifest or responses.

The shipped config wraps two key-less public JSON APIs: [frankfurter](https://frankfurter.dev) (`fxRate` free, `fxConvert`
0.0001 BEM) and Coinbase's public price API (`spotPrice`, `cryptoRates` free; `spotPrice` shows `{pair}` URL templating,
e.g. `BNB-USD`).

## All a company writes is the 10-line block above

Fields: `url` (may contain `{param}` path templates) · `method` · `headers` (with `${ENV}` expansion) · `priceBEM` · `params`/`returns`
(type hints copied into the manifest) · `defaults` · `required` · `query` (query key ← param) · `body` (POST JSON field ← param, or `"*"` = only the keys declared in `params`) ·
`pick` (return only these fields, dotted paths allowed).

Safety boundary (`adapter.mjs`, tested in `adapter.test.mjs`): `{param}` values are `encodeURIComponent`-ed and rejected if they contain `/`, `\`, `..`, `?`, `#`,
control characters or are a lone `.`; the template's static prefix must already be a full origin + path (no `{param}` in the host), and after substitution the
`origin` and path prefix are asserted unchanged; query values must be string/number/boolean; upstream headers come from config only, caller params never reach
them; upstream 4xx/5xx bodies go to the log, never to the caller (`INTERNAL` is always `"internal error"`).

## Run in three steps

```sh
npm install --no-audit --no-fund            # once, in tapeapi/
node examples/web2-adapter/index.mjs        # :8788 with an ephemeral signer key
node examples/web2-adapter/consumer.mjs     # second terminal: resolve -> free call -> paid-call demo
```

Two curls:

```sh
curl -s -X POST http://127.0.0.1:8788/tapeapi/v1/fxRate -H 'content-type: application/json' -d '{"id":"1","params":{"to":"JPY"}}'
curl -s -X POST http://127.0.0.1:8788/tapeapi/v1/spotPrice -H 'content-type: application/json' -d '{"id":"2","params":{"pair":"BNB-USD"}}'
```

`consumer.mjs` resolves with `api.resolve({ dev: url })`, calls `fxRate` (the SDK verifies the envelope signature before returning),
then signs a TAP-22 voucher with a random session key and calls `fxConvert`. In dev mode the manifest points at a zero-address escrow,
so the provider cannot check balance/allowance on-chain and answers with a *signed error envelope* (`INTERNAL`); the script prints the voucher
and envelope and explains. To exercise paid methods locally start the provider with `FREE_ALL=1` (dev only).

## Dev to mainnet

1. **Mint a circuit** on TapeOut → `circuits`/`tokenId`; container = `DeWebHub.accountOf(circuits, tokenId)`.
2. **Sign the delegation**: `HOLDER_KEY=0x.. node examples/reader-service/sign-delegation.mjs --container 0x.. --signer <printed signer> --expires .. --hub <DeWebHub>`;
   restart with `DELEGATION_SIG`/`DELEGATION_EXPIRES` plus `CONTAINER`, `CIRCUITS`, `TOKEN_ID`, `ESCROW`, `PUBLIC_URL`, `SIGNER_KEY`, `UPSTREAM_API_KEY` (`dev` becomes `false`).
3. **Publish the manifest**: copy `GET /.well-known/tapeapi.json` to the container's DeWEB site at `/.well-known/tapeapi.json`.
4. **Register the label**: send `api.tx.register({ circuits, tokenId, label: 'my-fx', manifestPath })` to ServiceDirectory.

Env vars are the same as `reader-service` (`PORT`, `SIGNER_KEY` — required once `DELEGATION_SIG` is set, the ephemeral key is never printed —, `RPC_URLS` with ≥ `QUORUM` distinct urls in production, `QUORUM`, `PUBLIC_URL`, ...) plus `ADAPTER_CONFIG` (path) and whatever `${ENV}` your headers reference.
