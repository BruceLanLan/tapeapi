# chain-attested-read — TAP-23 Attested Read：无桥读外链

**给谁**：公链 / L2（有 RPC 节点，想让 TapeOut 生态的应用无桥读你的链）。
**做什么**：一个 Attested Read 服务。对 `chains.json` 里配置的外链做 `eth_call`，每条链 **quorum 2**（SDK `createRpc`），
结果**锚定区块**并由 provider 签名。默认服务 Ethereum（`1`）与 Base（`8453`）：

| 方法 | 价格 | 返回 |
|---|---|---|
| `read({chainId, to, data, block?})`（也接受 TAP-23 的 `call: {to, data}`） | 0.0001 BEM | `{ chainId, blockNumber, blockHash, blockRef, result }` — 任意 eth_call |
| `balance({chainId, address, block?})` | 免费 | `{ chainId, address, wei, ether, blockNumber, blockHash, blockRef }` |
| `nftOwner({chainId, contract, tokenId, block?})` | 免费 | `{ chainId, contract, tokenId, owner, blockNumber, blockHash, blockRef }` — ERC-721 `ownerOf` |

`block` 可选：**省略 = `'finalized'`**（各节点该标签高度的最小值；节点不支持时退到 head − `lag`）；`'safe'`/`'finalized'`；`'latest'` = min(head) − `lag`；或具体区块号。
无论哪种，provider 都先要求 quorum 个节点对该块 **hash** 一致，然后**按该 blockHash** 读（EIP-1898 `{ blockHash, requireCanonical: true }`，TAP-23 §3.2）；
只有节点拒绝该参数时才退回按块号读并标 `blockRef: "number"`。所以 `blockHash` 是可核对的锚点，`result` 一定属于它。
`chains.json`：`{ "<chainId>": { "name", "rpcUrls": [...], "quorum": 2, "lag": 1 } }`，环境变量 `RPC_<chainId>=url1,url2` 可覆盖。

## 三步运行

```sh
npm install --no-audit --no-fund                     # 在 tapeapi/ 根目录，一次
node examples/chain-attested-read/index.mjs          # :8791
curl -s -X POST http://127.0.0.1:8791/tapeapi/v1/nftOwner -H 'content-type: application/json' \
  -d '{"id":"1","params":{"chainId":1,"contract":"0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D","tokenId":"1"}}'
```

```json
{"id":"1","ok":true,"result":{"chainId":1,"contract":"0xBC4C…f13D","tokenId":"1","owner":"0x46EF…2496",
 "blockNumber":26018944,"blockHash":"0x677c…755f"},"container":"0x…","ts":1789909961,"block":122995160,"sig":"0x…"}
```

`read` 是收费方法，本地调试加 `FREE_ALL=1`。很久以前的区块需要归档节点（公共节点常对旧块 eth_call 返回 403）。

## 场景：BSC 上的 DeWEB 应用按 Ethereum NFT 持有资格放行

游戏在 BSC，门票是 Ethereum 上的一个 NFT。前端不需要桥，向**两个独立**的 Attested Read 提供者各要一份签名读取，两者一致才放行。
`callQuorum` 要求结果 **canonicalJSON 逐字节相同**，而省略 `block` 时每家各自钉 `finalized`（时刻不同就会不同），所以先向任一提供者免费问一次拿到 `blockNumber`，
再把同一个 `block` 显式传给两家（TAP-23 §3.4 MUST），它们返回的 `blockHash`、`owner` 就必须完全一致；被探测的那家无法左右结果，另一家会独立核对该块 hash 并在该 hash 上读：

```js
import { createTapeAPI } from '../../sdk/src/index.js'          // DeWEB 站点：相对路径
const api = createTapeAPI({ rpcUrls: ['https://bsc-rpc.publicnode.com', 'https://bsc-dataseed.bnbchain.org', 'https://bsc-dataseed1.defibit.io'], quorum: 2, directory, escrow }) // ≥ 2 urls
const providers = await Promise.all([api.resolve('attest-eth-a'), api.resolve('attest-eth-b')]) // 两个不同 holder 的服务
const probe = await api.call(providers[0], 'nftOwner', { chainId: 1, contract: BAYC, tokenId })  // 免费；钉 finalized，只为拿一个块号
const params = { chainId: 1, contract: BAYC, tokenId, block: probe.result.blockNumber }        // 两家读同一个块
let owner
if (api.callQuorum) {                                            // SDK ≥ 0.2
  const r = await api.callQuorum(providers, 'nftOwner', params, { quorum: 2 })
  owner = r.result.owner                                         // 逐字节一致（同 owner、同 blockHash）才返回；否则 TapeAPIError('QUORUM_FAILED')
} else {
  const [a, b] = await Promise.all(providers.map(p => api.call(p, 'nftOwner', params)))
  if (a.result.owner !== b.result.owner || a.result.blockHash !== b.result.blockHash) throw new Error('attesters disagree')
  owner = a.result.owner
}
if (owner.toLowerCase() !== wallet.toLowerCase()) throw new Error('not a holder')
```

信任模型：单个服务只是一个签名者；两家独立一致才采用，不一致就拒绝，永远没有多数投票。
`blockNumber`/`blockHash` 让两份结果可以对齐到同一条链的同一高度附近；未来提供者可质押，签错结果可被同区块 Merkle 证明举证罚没（见 docs/CROSSCHAIN.md）。

## 从 dev 到主网

1. **铸电路**：在 TapeOut 铸一个电路 NFT → `circuits`/`tokenId`，容器 = `DeWebHub.accountOf(circuits, tokenId)`（身份与结算在 BSC，被读的链任意）。
2. **签委托**：`HOLDER_KEY=0x.. node examples/reader-service/sign-delegation.mjs --container 0x.. --signer <启动时打印的 signer> --expires .. --hub <DeWebHub>`；
   带 `DELEGATION_SIG`/`DELEGATION_EXPIRES`、`CONTAINER`、`CIRCUITS`、`TOKEN_ID`、`ESCROW`、`PUBLIC_URL`、`SIGNER_KEY` 重启，把 `chains.json` 换成你自己的节点。
3. **发布清单**：把 `GET /.well-known/tapeapi.json` 写到容器 DeWEB 站点 `/.well-known/tapeapi.json`。
4. **注册别名**：`api.tx.register({ circuits, tokenId, label: 'attest-eth-a', manifestPath })`。

---

# chain-attested-read — TAP-23 Attested Read: bridge-less reads of foreign chains

**For**: public chains / L2s that run RPC nodes and want TapeOut apps to read their chain without a bridge.
**What**: an Attested Read service. It performs `eth_call` on the chains configured in `chains.json` with **quorum 2 per chain** (SDK `createRpc`),
pins the result to a block and signs it. Defaults: Ethereum (`1`) and Base (`8453`). Methods: `read` (paid, arbitrary eth_call → `{chainId, blockNumber, blockHash, blockRef, result}`; also accepts TAP-23's `call: {to, data}`),
`balance` and `nftOwner` (free). `block` is optional: **omitted = `'finalized'`** (min across nodes; falls back to head − `lag` if a node lacks the tag); `'safe'`/`'finalized'`; `'latest'` = min(head) − `lag`; or a number.
In every case the provider first requires `quorum` nodes to agree on that block's **hash**, then evaluates **at that blockHash** (EIP-1898 `{ blockHash, requireCanonical: true }`, TAP-23 §3.2);
only if a node rejects that parameter does it fall back to the number and report `blockRef: "number"`. So `blockHash` is a checkable anchor and `result` provably belongs to it.
`chains.json`: `{ "<chainId>": { "name", "rpcUrls": [...], "quorum": 2, "lag": 1 } }`; `RPC_<chainId>=url1,url2` overrides it.

## Run in three steps

```sh
npm install --no-audit --no-fund                     # once, in tapeapi/
node examples/chain-attested-read/index.mjs          # :8791
curl -s -X POST http://127.0.0.1:8791/tapeapi/v1/nftOwner -H 'content-type: application/json' \
  -d '{"id":"1","params":{"chainId":1,"contract":"0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D","tokenId":"1"}}'
```

`read` is paid; use `FREE_ALL=1` locally. Old blocks need archive nodes (public nodes often answer 403 for historical eth_call).

## Scenario: a BSC DeWEB app gated on Ethereum NFT ownership

The game runs on BSC; the ticket is an NFT on Ethereum. No bridge: the front-end asks **two independent** Attested Read providers for a signed read and
admits the player only if both agree — see the JS above. `callQuorum` accepts only byte-identical canonicalJSON results, and without `block` each provider pins
`finalized` on its own, so probe one provider (free) for a block number and pass that same `block` explicitly to both (TAP-23 §3.4 MUST); then `owner` and
`blockHash` must match exactly. The probed provider cannot bias the result: the other one independently verifies that block's hash and evaluates at it. With `api.callQuorum` (SDK ≥ 0.2) that is one call with
`{ quorum: 2 }` (throws `QUORUM_FAILED` otherwise); on older SDKs call both and compare.
Trust model: one service is one signer; two independent agreeing signers are accepted, disagreement is rejected, never a majority vote.
`blockNumber`/`blockHash` let you align both answers to the same height; staking and slashing with same-block Merkle proofs is future work (docs/CROSSCHAIN.md).

## Dev to mainnet

1. **Mint a circuit** on TapeOut → `circuits`/`tokenId`; container = `DeWebHub.accountOf(circuits, tokenId)` (identity and settlement stay on BSC; the chain being read is arbitrary).
2. **Sign the delegation** with `examples/reader-service/sign-delegation.mjs`; restart with `DELEGATION_SIG`/`DELEGATION_EXPIRES`, `CONTAINER`, `CIRCUITS`, `TOKEN_ID`, `ESCROW`, `PUBLIC_URL`, `SIGNER_KEY`, and your own nodes in `chains.json`.
3. **Publish the manifest** served at `/.well-known/tapeapi.json` to the container's DeWEB site.
4. **Register the label**: `api.tx.register({ circuits, tokenId, label: 'attest-eth-a', manifestPath })`.

Env: `PORT`, `SIGNER_KEY` (required once `DELEGATION_SIG` is set; the ephemeral key is never printed), `RPC_URLS` (BSC, for identity/settlement; ≥ `QUORUM` distinct urls in production), `QUORUM`, `CHAINS_FILE`, `RPC_<chainId>`, `PUBLIC_URL`, `FREE_ALL` (dev).
