# 消费者片段 / Consumer snippets

三段可直接复制的消费者代码：浏览器 DeWEB 站点、Node 后端、原始 curl + 手工验签。
下面用 `http://127.0.0.1:8789`（defi-price-oracle，`bnbUsd` 免费）做例子，换成任何示例都一样。
主网上把 `{ dev: url }` 换成别名（`api.resolve('price-a')`）或容器地址，并给 `createTapeAPI` 传 `rpcUrls`、`directory`、`escrow`。

Three copy-paste consumers: a browser DeWEB site, a Node backend, and raw curl with manual signature verification.
Examples target `http://127.0.0.1:8789` (defi-price-oracle, free `bnbUsd`); any example works the same. On mainnet replace
`{ dev: url }` with a label (`api.resolve('price-a')`) or container address and pass `rpcUrls`, `directory`, `escrow` to `createTapeAPI`.

## 1. 浏览器 DeWEB 站点 / Browser DeWEB site

DeWEB 只允许相对路径：SDK 通过 `../../sdk/src/index.js` 引入，`@noble/*` 用 importmap 指到 `node_modules`（完整 importmap 见 `examples/demo-site/index.html`）。
DeWEB allows relative paths only: import the SDK as `../../sdk/src/index.js` and map `@noble/*` to `node_modules` with an importmap (full map in `examples/demo-site/index.html`).

```html
<script type="importmap">
{ "imports": {
  "@noble/curves/secp256k1": "../../node_modules/@noble/curves/esm/secp256k1.js",
  "@noble/curves/": "../../node_modules/@noble/curves/esm/",
  "@noble/hashes/sha3": "../../node_modules/@noble/hashes/esm/sha3.js",
  "@noble/hashes/utils": "../../node_modules/@noble/hashes/esm/utils.js",
  "@noble/hashes/": "../../node_modules/@noble/hashes/esm/"
} }
</script>
<script type="module">
import { createTapeAPI } from '../../sdk/src/index.js'

const api = createTapeAPI({ dev: true })                       // dev: true 才能 resolve({ dev }) 与 http 端点 / required for { dev } targets and http
                                                               // 主网 / mainnet: createTapeAPI({ rpcUrls: [≥2 urls], quorum: 2, directory, escrow })
const svc = await api.resolve({ dev: 'http://127.0.0.1:8789' }) // 主网 / mainnet: api.resolve('price-a')

// 免费方法：SDK 校验 TAPI-21 信封签名后才 resolve / free: the SDK verifies the envelope before resolving
const { result, block, verified } = await api.call(svc, 'bnbUsd', {})
console.log(result.bnbUsd, result.blockPinned, block, verified)

// 收费方法：钱包签 EIP-712 voucher（TAPI-22）/ paid: wallet signs the EIP-712 voucher
const [consumer] = await window.ethereum.request({ method: 'eth_requestAccounts' })
const payer = api.payer({
  consumer,
  signTypedData: (typed) => window.ethereum.request({ method: 'eth_signTypedData_v4', params: [consumer, JSON.stringify(typed)] }),
})
const paid = await api.call(svc, 'pairPrice', { pair: '0x16b9a82891338f9bA80E2D6970FddA79D1eb0daE' }, { payer })

// 多提供者一致：结果需逐字节相同。省略 block 时每家各自钉 `finalized` 并把块写进结果，
// 所以先用上面那次调用返回的 blockPinned.blockNumber，再把同一个 block 传给每一家（TAPI-23 §3.4：法定人数轮 MUST 用显式区块号）。
// multi-provider agreement: results must be byte-identical. Without `block` each provider pins `finalized`
// on its own and returns the block, so reuse blockPinned.blockNumber from the call above and pass the same block to
// every provider (TAPI-23 §3.4: the quorum round MUST use an explicit block number).
const other = await api.resolve({ dev: 'http://127.0.0.1:8799' })
const block = result.blockPinned.blockNumber                     // 复用上面那次调用的块号 / reuse the block from the call above
const q = await api.callQuorum([svc, other], 'bnbUsd', { block }, { quorum: 2 })
console.log('agreed:', q.result.bnbUsd, 'by', q.agreed)          // 不一致 → TapeAPIError('QUORUM_FAILED')
</script>
```

每次签 voucher 都弹钱包太烦：先 `api.tx.authorizeSession(svc.container, sessionKeyAddress, expires)` 上链一次，然后 `api.payer({ consumer, sessionKey, sessionExpiry: expires })` 本地静默签。
计费语义：`api.call` 只在收到已验证的响应后才推进本地累计；网络失败会释放预留；若 provider 其实已入账，下一张凭证会被签名的 `BAD_VOUCHER { data.lastCumulative }` 拒绝，SDK 自动重同步并重试一次。
传 `store: { get, set }`（例如 localStorage 包装）可让累计跨刷新保留。并发 `Promise.all([api.call(...), api.call(...)])` 是安全的。
Signing every voucher in the wallet is annoying: send `api.tx.authorizeSession(svc.container, sessionKeyAddress, expires)` once, then `api.payer({ consumer, sessionKey, sessionExpiry: expires })` signs locally.
Metering: `api.call` advances the local cumulative only after a verified response; a transport failure releases the reservation; if the provider had in fact consumed it, the next voucher is rejected with a signed `BAD_VOUCHER { data.lastCumulative }` and the SDK resyncs and retries once.
Pass `store: { get, set }` (e.g. a localStorage wrapper) to keep the cumulative across reloads. Concurrent `Promise.all([api.call(...), api.call(...)])` is safe.

## 2. Node 后端 / Node backend

```js
// node >= 20, ESM. 在 tapeapi/ 工作区内用 '@tapeapi/sdk'，否则用相对路径 '<repo>/sdk/src/index.js'
// node >= 20, ESM. Inside the tapeapi/ workspace import '@tapeapi/sdk'; elsewhere use a relative path to sdk/src/index.js
import { createTapeAPI, TapeAPIError, formatUnits } from '@tapeapi/sdk'

const api = createTapeAPI({ dev: true })                              // mainnet: { rpcUrls: [>= 2 urls], quorum: 2, directory, escrow } (fewer urls than quorum throws unless allowSingleNode: true)
const svc = await api.resolve({ dev: process.env.PROVIDER_URL || 'http://127.0.0.1:8789' })

const free = await api.call(svc, 'bnbUsd', {})
console.log('BNB/USD', free.result.bnbUsd, 'pinned', free.result.blockPinned, 'verified', free.verified)

// 收费：session key 本地签 voucher；主网前需三笔交易：approve(托管) → fund(provider) → authorizeSession(provider, key)
// paid: a session key signs vouchers locally; on mainnet three transactions come first:
//   approve(escrow) -> fund(provider) -> authorizeSession(provider, key)
const payer = api.payer({ consumer: process.env.CONSUMER, sessionKey: process.env.SESSION_KEY, sessionExpiry: Number(process.env.SESSION_EXPIRES) || undefined })
try {
  const r = await api.call(svc, 'pairPrice', {}, { payer })
  console.log(r.result.price, 'cumulative owed', formatUnits(payer.cumulativeOf(svc)), 'BEM')
} catch (e) {
  if (e instanceof TapeAPIError) console.error(e.code, e.message, e.signed ? '(signed error envelope)' : '')
  else throw e
}

// 两个独立提供者一致才用 / accept only when two independent providers agree
const [a, b] = await Promise.all([api.resolve({ dev: 'http://127.0.0.1:8789' }), api.resolve({ dev: 'http://127.0.0.1:8799' })])
const block = free.result.blockPinned.blockNumber                   // 同一个块 → 逐字节一致（默认各自钉 finalized，必须显式传）/ same block -> byte-identical (providers pin `finalized` on their own otherwise)
const q = await api.callQuorum([a, b], 'bnbUsd', { block }, { quorum: 2 })
console.log('agreed', q.result.bnbUsd, 'by', q.agreed, 'disagreed', q.disagreed, 'failed', q.failed) // else TapeAPIError('QUORUM_FAILED')
```

准备主网的三笔交易（SDK 只构造 calldata，由你的钱包/签名器发送）/ the three mainnet setup txs (SDK builds calldata; your wallet sends):
`api.tx.approve({ amount: parseUnits('1'), spender: svc })` · `api.tx.fund(svc, parseUnits('1'))` · `api.tx.authorizeSession(svc, sessionAddress, expires)`.
The approval comes first: the escrow moves BEM with `transferFrom`, so without it `fund` reverts inside the token.
先做授权：托管合约用 `transferFrom` 划转 BEM，缺了它 `fund` 会在代币合约里回滚。

## 3. 原始 curl + 手工验签 / Raw curl + manual signature verification

```sh
curl -s -X POST http://127.0.0.1:8789/tapeapi/v1/bnbUsd -H 'content-type: application/json' \
  -d '{"id":"req-1","params":{}}' > envelope.json
cat envelope.json
# {"id":"req-1","ok":true,"result":{"bnbUsd":"753.71976675",...},"container":"0x…","ts":1789909713,"block":122994612,"sig":"0x…"}
```

收费方法：在请求体里加 `"voucher": {"consumer","provider","cumulative","expires","sig","signer"}`（`api.payer(...).voucherFor(svc, price)` 生成，见 `web2-adapter/consumer.mjs`）。
Paid methods: add `"voucher": {...}` to the body (produced by `api.payer(...).voucherFor(svc, price)`, see `web2-adapter/consumer.mjs`).

TAPI-21 v2 验签：`digest = keccak256("TAPI-1/resp/v2" ‖ container ‖ keccak256(id) ‖ keccak256(canonicalJSON({method, params})) ‖ uint8(ok) ‖ keccak256(canonicalJSON(result|error)) ‖ uint64BE(ts))`，
签名是对 digest 的 EIP-191 personal_sign（低 s）；恢复出的地址必须等于清单里的 `signer`（清单再由 holder 的委托签名背书）。
注意 `method`/`params` 用**你发出的**请求（这里是 `bnbUsd` / `{}`），`container` 用你解析出的容器，`ok` 来自信封；还要检查 `|now − ts| ≤ 300`。
Verify TAPI-21 v2: recover the EIP-191 signer (low-s) of that digest and compare with `manifest.signer` (which the holder's delegation vouches for).
`method`/`params` are the request **you sent** (`bnbUsd` / `{}` here), `container` is the one you resolved, `ok` comes from the envelope; also check `|now − ts| <= 300`.

```sh
node --input-type=module -e '
import { readFileSync } from "node:fs"
import { sig, abi, canonicalJSON } from "@tapeapi/sdk"          // 或 / or: "./sdk/src/index.js"
const env = JSON.parse(readFileSync("envelope.json", "utf8"))
const manifest = await (await fetch("http://127.0.0.1:8789/.well-known/tapeapi.json")).json()
const body = env.ok ? env.result : env.error
const req = { method: "bnbUsd", params: {} }                         // 你发出的请求 / the request you sent
const input = { container: env.container, id: env.id, method: req.method, params: req.params, ok: env.ok, body, ts: env.ts }
const recovered = sig.recoverResponseSigner(input, env.sig)
console.log("digest   ", abi.toHex(sig.responseDigest(input)))
console.log("canonical", canonicalJSON(body).slice(0, 80) + "...")
console.log("recovered", recovered, "manifest.signer", manifest.signer, "match", abi.eqAddr(recovered, manifest.signer))
'
```

用其它语言验签时按同样步骤：键排序、无空白的 JSON（对 `{method, params}` 与 body 各做一次）→ keccak → 按 §3.3 顺序拼接（含 1 字节 ok）→ keccak → `"\x19Ethereum Signed Message:\n32"` 前缀 → secp256k1 恢复，并拒绝 s > n/2。
In another language follow the same steps: sorted-key whitespace-free JSON (once for `{method, params}`, once for the body) → keccak → concat in the §3.3 order (including the 1-byte ok) → keccak → `"\x19Ethereum Signed Message:\n32"` prefix → secp256k1 recover, rejecting s > n/2.

## 4. DeFi 前端：两家提供者一致才渲染 / DeFi front-end: render only on agreement

一个借贷前端要显示"这个地址会不会被清算"。**任何一家单独说了都不算数**：要么两家独立提供者在**同一个区块**上
给出逐字节相同的答案，要么什么都不显示。下面的片段跨两家调 `defi-lending-health` 的 `accountHealth`
（逐字节比较），再跨两家调 `defi-twap-oracle` 的 `bnbUsdTwap`（**±1% 的数值容差**）。

A lending front-end wants to show whether an address is liquidatable. **No single provider's word counts**:
either two independent providers give a byte-identical answer at the **same block**, or nothing is rendered.
Below: `accountHealth` from `defi-lending-health` across two providers (byte-for-byte), then `bnbUsdTwap` from
`defi-twap-oracle` across two providers (**with a ±1% numeric tolerance**).

```html
<script type="module">
import { createTapeAPI, TapeAPIError } from '../../sdk/src/index.js'

const api = createTapeAPI({ dev: true })   // 主网 / mainnet: { rpcUrls:[≥2], quorum:2, directory, escrow }

// 第二家一律取主端口 + 10（8792→8802、8793→8803），与本文件 8789→8799 的约定一致。
// The second instance is always main port + 10, matching this file's 8789 -> 8799 convention.
const [healthA, healthB, twapA, twapB] = await Promise.all([
  api.resolve({ dev: 'http://127.0.0.1:8792' }), api.resolve({ dev: 'http://127.0.0.1:8802' }),
  api.resolve({ dev: 'http://127.0.0.1:8793' }), api.resolve({ dev: 'http://127.0.0.1:8803' }),
])

// ── 独立性前置检查（TAPI-23 §3.5）。SDK 的 callQuorum **不替你做这个检查** ──
// 它只拒绝重复的 container；"两家是不是真的独立"是调用方的责任。
// The independence check (TAPI-23 §3.5). callQuorum does NOT do this for you — it only rejects duplicate
// containers. Whether two providers are genuinely independent is the caller's problem.
const origin = (s) => new URL(s.manifest.endpoints.live[0]).origin
function independent(a, b) {
  if (origin(a) === origin(b)) return false                     // 同一个端点 origin / same endpoint origin
  if (a.container.toLowerCase() === b.container.toLowerCase()) return false
  // 主网上真正要比的是电路持有人。dev 清单没有 delegation，两边的 holder 都是 null，
  // 所以只有拿到了真实 holder 时才做这一步 —— 否则 null === null 会把本地演示误判成"不独立"。
  // On mainnet the real check is the circuit holder. Dev manifests have no delegation, so both holders are
  // null; only compare them when they actually exist, or `null === null` would fail the local demo.
  if (a.verified.holder && b.verified.holder) return a.verified.holder !== b.verified.holder
  return true
}
if (!independent(healthA, healthB)) {
  render({ state: 'refused', reason: 'providers are not independent (same holder or same origin)' })
  throw new Error('not independent')
}

const account = '0xeba4b3c462b9c16f7ccaf4be6f4d3c17c377411e'

// ── ① 健康因子：逐字节一致，**不用容差** ──
// accountHealth 是同一区块上同一次 eth_call 的确定性结果，两家必须一模一样。
// 这里开容差只会掩盖真正的分歧 —— 容差是给跨源派生数值准备的，见 ②。
// accountHealth is the deterministic result of one eth_call at one block; the two must match exactly.
// A tolerance here would only mask a real disagreement. Tolerance is for derived cross-source numbers (②).
async function health() {
  // 第 1 步：任取一家拿到锚定块号（这一次的结果只用来取块号，不用来渲染）
  // Step 1: ask one provider for the pinned block number only — this answer is never rendered.
  const first = await api.call(healthA, 'accountHealth', { account })
  const block = first.result.blockPinned.blockNumber

  // 第 2 步：同一个**显式数字块号**发给两家（TAPI-23 §3.4 第 2 步，MUST）
  // 第 3–5 步：各自验签 → 逐字节比较 → 任意两份已验签结果不同即拒绝，**不做多数表决**
  const q = await api.callQuorum([healthA, healthB], 'accountHealth', { account, block }, { quorum: 2 })
  return { ...q.result, agreedBy: q.agreed }
}

// ── ② 价格：±1% 的有界比较 ──
// 两家跑的是**不同的池**（fee 100 / fee 500），数值必然不同。界取 100 bps，与 Venus 的 BoundValidator
// 对 BNB 用的上界 1.01 / 下界 0.99 同量级 —— 这才是真实借贷协议对"多源一致"的定义。
// The two run DIFFERENT pools (fee 100 / fee 500), so the numbers must differ. The bound is 100 bps, the same
// order as Venus's BoundValidator (upper 1.01 / lower 0.99 for BNB) — what a real lending protocol means by
// "sources agree".
//
// 三条边界：
//   a. `paths` 之外的一切仍然逐字节比较 —— `deviates`、`window` 和**整个 blockPinned（块号与块 hash）**
//      必须完全相同。容差放开的是**价格，不是区块**。
//   b. 因此 `meanTick` 也必须写进 `paths`：两个池的 tick 不同，不放开就永远凑不成一组。
//   c. `paths` 指到不是有限数字的字段（null / 布尔 / 缺失）会抛 `BAD_REQUEST` —— 那是调用方的错。
// Three boundaries: (a) everything outside `paths` is still byte-compared, including all of `blockPinned` —
// tolerance loosens the price, never the block; (b) so `meanTick` must be in `paths` too, or two pools'
// differing ticks keep the skeletons apart forever; (c) a path pointing at a non-number throws BAD_REQUEST.
async function bnbUsd() {
  const first = await api.call(twapA, 'bnbUsdTwap', {})
  const block = first.result.blockPinned.blockNumber
  const q = await api.callQuorum([twapA, twapB], 'bnbUsdTwap', { block }, {
    quorum: 2,
    compare: { relTolBps: 100, paths: ['bnbUsd', 'bnbUsdSpot', 'meanTick'] },
  })
  // q.result 是**先到者**的答案，不是平均值 —— 容差只决定"算不算同一组"，绝不合成新数字。
  // q.result is the FIRST answer, not an average — tolerance decides grouping and never synthesises a number.
  return { bnbUsd: q.result.bnbUsd, deviates: q.result.deviates, atBlock: q.result.blockPinned.blockNumber, agreedBy: q.agreed }
}

try {
  const [h, p] = await Promise.all([health(), bnbUsd()])
  render({
    state: 'ok',
    healthFactor: h.healthFactor,          // 定点字符串，不要 parseFloat 后再四舍五入 / keep the string; never parseFloat then round
    liquidatable: h.liquidatable,          // 来自链上 shortfall，不是我们派生的健康因子 / from the chain's shortfall
    atBlock: h.blockPinned.blockNumber,    // 这个判断属于哪个区块，UI 上要看得见 / which block this verdict belongs to
    blockHash: h.blockPinned.blockHash,
    sources: h.agreedBy,                   // 两个 container 地址，UI 上要可见 / both containers, visible in the UI
    bnbUsd: p.bnbUsd,
    priceDeviates: p.deviates,             // true → 现价与半小时均价分叉，降杠杆 / spot has diverged from the 30-min mean
  })
} catch (e) {
  if (e instanceof TapeAPIError && e.code === 'QUORUM_FAILED') {
    // 不投票、不取平均、不退化到单家。
    // 细节在 e.data 里（1.0 起；顶层的 e.groups 等只是弃用别名，2.0 删除）。
    // No vote, no average, no falling back to one provider. The details are in e.data (1.0; the top-level
    // e.groups and friends are deprecated aliases, gone in 2.0).
    console.warn('disagreed:', e.data.disagreed, 'groups:', e.data.groups, 'failed:', e.data.failed)
    render({ state: 'refused', reason: 'providers disagreed on the same block; nothing rendered' })
  } else if (e instanceof TapeAPIError) {
    render({ state: 'error', code: e.code })
  } else throw e
}
</script>
```

本地跑起来（四个实例，第二家一律 +10；两家 TWAP 故意用不同费率档的池，容差才有东西可比）：
Run it locally (four instances, the second always +10; the two TWAP instances deliberately use different fee
tiers so that tolerance has something to compare):

```sh
FREE_ALL=1 PORT=8792 node examples/defi-lending-health/index.mjs
FREE_ALL=1 PORT=8802 CONTAINER=0x00000000000000000000000000000000000000B2 node examples/defi-lending-health/index.mjs
FREE_ALL=1 PORT=8793 node examples/defi-twap-oracle/index.mjs
FREE_ALL=1 PORT=8803 CONTAINER=0x00000000000000000000000000000000000000B3 \
  POOL=0x36696169C63e42cd08ce11f5deeBbCeBae652050 node examples/defi-twap-oracle/index.mjs
```

实测（同一个显式块 123018935，两个费率档）：逐字节比较 → `QUORUM_FAILED`，两组分别是
`bnbUsd 757.003999741106332524 / meanTick -66297` 与 `756.852621648250465948 / -66295`；
`relTolBps: 100` → 两家成组通过；`relTolBps: 1` → 仍然失败（两家差约 2 bps）。
Measured at the same explicit block across two fee tiers: exact → `QUORUM_FAILED` with those two groups;
`relTolBps: 100` → agreed; `relTolBps: 1` → still failed (~2 bps apart).

三点说明 / three notes:

- **为什么拒绝渲染而不是显示多数结果**：TAPI-23 §4「Reject on disagreement」—— 多数表决把 3 家变成一个
  2-of-3 委员会，那个门槛本身成为新的攻击面。拒绝的失败模式是**拒绝服务**，永远不是**错误答案**。
  `callQuorum` 的默认就是 `onDissent: 'reject'`：**只要出现两个不同的桶就失败**。
  Why refuse instead of showing the majority: TAPI-23 §4 “Reject on disagreement”. A majority vote turns three
  providers into a 2-of-3 committee, and that threshold becomes the new attack surface. Refusing fails as
  **denial of service**, never as a **wrong answer**. `callQuorum` defaults to `onDissent: 'reject'`.
- **为什么块号要显式传**：不传的话每家各自钉自己的 `finalized`，块不同 → 结果天然不同 → 必然
  `QUORUM_FAILED`。这也是为什么容差**不能**放开 `blockPinned`：那会让两家在**不同区块**上的答案被当成一致。
  Why the block number is passed explicitly: otherwise each provider pins its own `finalized`, the blocks
  differ and the results must differ. It is also why tolerance must never cover `blockPinned` — that would let
  answers from **different blocks** count as agreement.
- **这个 UI 得到的保证边界**：两家**独立**提供者在**同一区块**上给出了（逐字节相同 / 在 ±1% 界内的）答案，
  并各自签名。它**不保证**这个答案正确 —— 两家的上游节点若同源仍会一起错（TAPI-23 §8「Upstream compromise」），
  也**没有**质押或罚没（TAPI-23 §3.6 明确把经济安全留给未来的 TAP）。按 Chainlink 自己对 single-source feed
  的要求，用它的协议仍然必须外加界限、熔断、新鲜度检查和 kill switch。
  What this UI actually guarantees: two **independent** providers gave answers (byte-identical, or within
  ±1%) at the **same block**, each signed. It does **not** guarantee the answer is correct — if both upstream
  node sets share an origin they fail together (TAPI-23 §8 “Upstream compromise”) — and there is **no** stake
  or slashing (TAPI-23 §3.6 defers economic security to a future TAP). By Chainlink's own standard for
  single-source feeds, a protocol consuming this must still add bounds, circuit breakers, freshness checks and
  a kill switch.
