# defi-price-oracle — 不需要委员会的可验证价格源

**给谁**：DeFi 协议与前端。
**做什么**：一个 TapeAPI 服务，直接读 PancakeSwap V2 pair 的 `getReserves()`：

| 方法 | 价格 | 说明 |
|---|---|---|
| `bnbUsd({block?})` | 免费 | 由默认 WBNB/USDT V2 pair 推导的 BNB 美元价；运行时用 `token0()`/`token1()` 判断方向 |
| `pairPrice({pair?, block?})` | 0.0001 BEM | 任意 V2 pair：`token0/token1`（地址、symbol、decimals）、储备、双向价格 |

每次读取都通过 SDK 的 `createRpc({ quorum: 2 })` 向多个公共 BSC 节点发 `eth_call`，**至少两个节点结果一致**才返回；
并**锚定到一个区块**：省略 `block` 时钉 **`finalized`**（各节点该标签高度的最小值；节点不支持该标签时退到 head − `BLOCK_LAG`，默认 15），
要求 quorum 个节点对该块 hash 一致，再**按该 blockHash**（EIP-1898 `{ blockHash, requireCanonical: true }`）读储备——节点拒绝时才退回块号并在结果里标 `blockRef: "number"`。
调用方也可传 `block`（区块号 / `'latest'`）指定锚点。结果里**总是**带 `blockPinned: { blockNumber, blockHash, blockRef }`，整个响应由 provider 签名（TAP-21 v2）。

## 三步运行

```sh
npm install --no-audit --no-fund                 # 在 tapeapi/ 根目录，一次
node examples/defi-price-oracle/index.mjs        # :8789；PAIR=0x.. 可换默认 pair
curl -s -X POST http://127.0.0.1:8789/tapeapi/v1/bnbUsd -H 'content-type: application/json' -d '{"id":"1","params":{}}'
```

响应形如：

```json
{"id":"1","ok":true,"result":{"bnbUsd":"753.71976675","pair":"0x16b9…0daE","source":"pancakeswap-v2",
 "blockPinned":{"blockNumber":122994612,"blockHash":"0x9422…b78d"}},"container":"0x…","ts":1789909713,"block":122994612,"sig":"0x…"}
```

`pairPrice` 是收费方法；本地调试加 `FREE_ALL=1`（仅 dev 生效）。

## 前端怎么用：两个独立提供者，无委员会

单个服务只是一个签名者。DeFi 前端应当解析**两个互不相关的**价格服务（不同 holder、不同 RPC 节点），
用 SDK 的 `callQuorum` 要求两者结果一致。`callQuorum` 的规则是 **canonicalJSON 逐字节相同**，所以要让两个提供者读**同一个块**：
先向任一家免费调一次 `bnbUsd`（它会钉 `finalized` 并把块写进 `blockPinned`），再把这个 `blockNumber` 作为 `block` 显式传给两家
（TAP-23 §3.4：法定人数轮 MUST 用显式区块号；否则各自锚定的 `blockPinned` 不同，永远不会一致）。第一家无法左右结果：第二家会独立核对该块的 hash 并在该 hash 上读。

```js
import { createTapeAPI } from '@tapeapi/sdk'
const api = createTapeAPI({ rpcUrls: ['https://bsc-dataseed.bnbchain.org', 'https://bsc-mainnet.public.blastapi.io', 'https://rpc-bsc.48.club'], quorum: 2, directory, escrow }) // ≥ 2 家运营方，否则抛错 / nodes of ≥ 2 operators, or it throws
const [a, b] = await Promise.all([api.resolve('price-a'), api.resolve('price-b')])
const probe = await api.call(a, 'bnbUsd', {})            // 免费；只为拿一个 finalized 块号 / free; just to get a finalized block
const block = probe.result.blockPinned.blockNumber       // 两家都读这个块 / both providers read this block
let price
if (api.callQuorum) {                                    // SDK ≥ v0.2
  const r = await api.callQuorum([a, b], 'bnbUsd', { block }, { quorum: 2 })
  price = r.result.bnbUsd                                // 两份签名结果逐字节一致才返回，否则抛 TapeAPIError('QUORUM_FAILED')；r.agreed / r.disagreed / r.failed 列出各家
} else {                                                 // 手工版 / manual
  const [ra, rb] = await Promise.all([api.call(a, 'bnbUsd', { block }), api.call(b, 'bnbUsd', { block })])
  if (ra.result.bnbUsd !== rb.result.bnbUsd || ra.result.blockPinned.blockHash !== rb.result.blockPinned.blockHash) throw new Error('providers disagree')
  price = ra.result.bnbUsd
}
```

没有多数投票，没有委员会：两家独立、都签了名、结果一致，就采用；否则拒绝。这与 TapeKit 内核的规则相同。

## 从 dev 到主网

1. **铸电路**：在 TapeOut 铸一个电路 NFT → `circuits`/`tokenId`，容器 = `DeWebHub.accountOf(circuits, tokenId)`。
2. **签委托**：`HOLDER_KEY=0x.. node examples/reader-service/sign-delegation.mjs --container 0x.. --signer <启动时打印的 signer> --expires .. --hub <DeWebHub>`；
   带 `DELEGATION_SIG`/`DELEGATION_EXPIRES`、`CONTAINER`、`CIRCUITS`、`TOKEN_ID`、`ESCROW`、`PUBLIC_URL`、`SIGNER_KEY` 重启。
3. **发布清单**：把 `GET /.well-known/tapeapi.json` 写到容器 DeWEB 站点 `/.well-known/tapeapi.json`。
4. **注册别名**：`api.tx.register({ circuits, tokenId, label: 'price-a', manifestPath })`。

---

# defi-price-oracle — a verifiable price feed without a committee

**For**: DeFi protocols and front-ends.
**What**: a TapeAPI service that reads PancakeSwap V2 `getReserves()` directly.

| method | price | what |
|---|---|---|
| `bnbUsd({block?})` | free | BNB in USD from the default WBNB/USDT V2 pair; orientation checked at runtime via `token0()`/`token1()` |
| `pairPrice({pair?, block?})` | 0.0001 BEM | any V2 pair: `token0/token1` (address, symbol, decimals), reserves, both prices |

Every read goes through the SDK's `createRpc({ quorum: 2 })` against several public BSC nodes, so **at least two nodes must agree**,
and is **pinned to one block**: `finalized` when `block` is omitted (min across nodes; falls back to head − `BLOCK_LAG`, default 15, if a node lacks the tag),
with `quorum` nodes agreeing on that block's hash, then reserves are read **at that blockHash** (EIP-1898 `{ blockHash, requireCanonical: true }`; only if a node
rejects that does it fall back to the number, reported as `blockRef: "number"`). Callers may pass `block` (number / `'latest'`) to choose the anchor.
Results **always** carry `blockPinned: { blockNumber, blockHash, blockRef }` and the whole envelope is signed (TAP-21 v2).

## Run in three steps

```sh
npm install --no-audit --no-fund                 # once, in tapeapi/
node examples/defi-price-oracle/index.mjs        # :8789; PAIR=0x.. overrides the default pair
curl -s -X POST http://127.0.0.1:8789/tapeapi/v1/bnbUsd -H 'content-type: application/json' -d '{"id":"1","params":{}}'
```

`pairPrice` is paid; use `FREE_ALL=1` for local debugging (dev only).

## How a front-end uses it: two independent providers, no committee

One service is one signer. A DeFi front-end should resolve **two unrelated** price services (different holders, different RPC nodes)
and require agreement with the SDK's `callQuorum` (JS above). `callQuorum` accepts only **byte-identical canonicalJSON** results, so pass the same `block`
to both providers: probe one of them (free `bnbUsd`, which pins `finalized` and returns `blockPinned`) and re-send its `blockNumber` explicitly
(TAP-23 §3.4: the quorum round MUST use an explicit block); otherwise their `blockPinned` differ and they can never agree. The probed provider cannot bias
the result: the other one independently checks that block's hash and reads at that hash.
On disagreement it throws `TapeAPIError('QUORUM_FAILED')` with `agreed`/`disagreed`/`failed`. If `api.callQuorum` is missing (SDK < 0.2) call both and compare yourself. No majority vote, no committee: two independent signed
results that agree are accepted, anything else is rejected — the same rule the TapeKit kernel uses.

## Dev to mainnet

1. **Mint a circuit** on TapeOut → `circuits`/`tokenId`; container = `DeWebHub.accountOf(circuits, tokenId)`.
2. **Sign the delegation** with `examples/reader-service/sign-delegation.mjs` (holder key, container, printed signer, expiry; `--hub` defaults to the mainnet DeWebHub — **not** a ServiceDirectory);
   restart with `DELEGATION_SIG`/`DELEGATION_EXPIRES`, `CONTAINER`, `CIRCUITS`, `TOKEN_ID`, `ESCROW`, `PUBLIC_URL`, `SIGNER_KEY`.
3. **Publish the manifest** served at `/.well-known/tapeapi.json` to the container's DeWEB site.
4. **Register the label**: `api.tx.register({ circuits, tokenId, label: 'price-a', manifestPath })`.

Env: `PORT`, `SIGNER_KEY` (required once `DELEGATION_SIG` is set; the ephemeral key is never printed), `RPC_URLS` (urls of ≥ `QUORUM` distinct operators in production; default: the SDK's `rpcUrlsFor(56)`), `QUORUM`, `BLOCK_LAG` (fallback lag when `finalized` is unsupported), `PAIR`, `WBNB`, `USDT`, `PUBLIC_URL`, `FREE_ALL` (dev).
