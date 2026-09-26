# gaming-leaderboard — 跟着玩家走的排行榜与存档

**给谁**：游戏工作室（游戏服务器 + 排行榜 + 存档）。
**做什么**：把排行榜和存档封成一个 TapeAPI 服务。玩家用自己的钱包私钥签分数和存档，provider 只认签名，不认账号：

| 方法 | 价格 | 说明 |
|---|---|---|
| `submitScore({player, score, nonce, sig})` | 免费 | `sig` = 玩家对 `keccak256("TAPI-game/score/v1" ‖ player ‖ uint64(score) ‖ uint64(nonce))` 的 personal_sign；nonce 必须递增（防重放）；只保留最高分 |
| `top({n?})` | 免费 | 前 n 名（默认 10，最多 100） |
| `saveState({player, state, nonce, sig})` | 0.0001 BEM | `sig` 覆盖 `keccak256(canonicalJSON(state))`；≤16 KB |
| `loadState({player})` | 免费 | 读存档 |

数据在内存里，落到 `leaderboard.data.json`（`DATA_FILE` 可改，tmp+rename 原子写入）。签名格式在 `score-sig.mjs`，客户端与 provider 共用；
钱包侧就是 `personal_sign(hexDigest)`，MetaMask / WalletConnect 直接可用。

## 容器即存档槽（下一步）

现在存档存在 provider 这里。TapeOut 里每个电路 NFT 都有一个 ERC-6551 容器和一个 DeWEB 站点；
下一步是让 `saveState` 把存档写到**玩家自己的容器**的站点路径（例如 `/.games/<gameId>/save.json`），provider 只做签名与索引：
存档随玩家 NFT 转移，另一款游戏可以（经玩家授权）读取同一份存档，工作室关服也不会丢。排行榜同理可以按容器地址而不是钱包地址记账。
回合结算规则未来可作为 TAP-25 电路校验方法上链重算，作弊可举证。

## 三步运行

```sh
npm install --no-audit --no-fund                     # 在 tapeapi/ 根目录，一次
node examples/gaming-leaderboard/index.mjs           # :8790
node examples/gaming-leaderboard/player.mjs          # 另一个终端：随机玩家签名 → submitScore → top → saveState → loadState
```

一条 curl（先让脚本替你签好；每次 nonce 不同）：

```sh
node examples/gaming-leaderboard/player.mjs http://127.0.0.1:8790 4321 --print-only
# 打印形如：
curl -s -X POST http://127.0.0.1:8790/tapeapi/v1/submitScore -H 'content-type: application/json' \
  -d '{"id":"1","params":{"player":"0xC673…0A6e","score":4321,"nonce":1789909929174,"sig":"0xc45f…d191b"}}'
# -> {"id":"1","ok":true,"result":{"player":"0xC673…0A6e","best":4321,"rank":1,"accepted":true},"container":"0x…","ts":…,"block":…,"sig":"0x…"}
curl -s -X POST http://127.0.0.1:8790/tapeapi/v1/top -H 'content-type: application/json' -d '{"id":"2","params":{"n":3}}'
```

`saveState` 是收费方法，dev 模式下 provider 查不到链上 escrow，会返回签名的错误信封；本地调试加 `FREE_ALL=1`。

## 从 dev 到主网

1. **铸电路**：在 TapeOut 铸一个电路 NFT → `circuits`/`tokenId`，容器 = `DeWebHub.accountOf(circuits, tokenId)`。
2. **签委托**：`HOLDER_KEY=0x.. node examples/reader-service/sign-delegation.mjs --container 0x.. --signer <启动时打印的 signer> --expires .. --hub <DeWebHub>`；
   带 `DELEGATION_SIG`/`DELEGATION_EXPIRES`、`CONTAINER`、`CIRCUITS`、`TOKEN_ID`、`ESCROW`、`PUBLIC_URL`、`SIGNER_KEY`、`DATA_FILE` 重启。
3. **发布清单**：把 `GET /.well-known/tapeapi.json` 写到容器 DeWEB 站点 `/.well-known/tapeapi.json`。
4. **注册别名**：`api.tx.register({ circuits, tokenId, label: 'my-game', manifestPath })`。

---

# gaming-leaderboard — a leaderboard and save slots that follow the player

**For**: game studios (game server + leaderboard + saves).
**What**: leaderboard and saves as one TapeAPI service. Players sign scores and saves with their own wallet key; the provider trusts signatures, not accounts.

| method | price | what |
|---|---|---|
| `submitScore({player, score, nonce, sig})` | free | `sig` = player's personal_sign over `keccak256("TAPI-game/score/v1" ‖ player ‖ uint64(score) ‖ uint64(nonce))`; nonce must increase (replay protection); best score kept |
| `top({n?})` | free | top n (default 10, max 100) |
| `saveState({player, state, nonce, sig})` | 0.0001 BEM | `sig` covers `keccak256(canonicalJSON(state))`; ≤16 KB |
| `loadState({player})` | free | read a save |

State lives in memory and is persisted to `leaderboard.data.json` (`DATA_FILE`, atomic tmp+rename). Signature formats are in `score-sig.mjs`, shared by
clients and provider; on the wallet side it is plain `personal_sign(hexDigest)`, so MetaMask / WalletConnect work as-is.

## Container as save slot (next step)

Today the save lives with the provider. In TapeOut every circuit NFT has an ERC-6551 container with a DeWEB site; the next step is for `saveState`
to write the save into the **player's own container** (e.g. `/.games/<gameId>/save.json`) with the provider only signing and indexing.
The save then travels with the player's NFT, another game can read it (with the player's consent), and it survives the studio shutting down.
Round settlement rules can later become TAP-25 circuit-verified methods, making cheating provable.

## Run in three steps

```sh
npm install --no-audit --no-fund                     # once, in tapeapi/
node examples/gaming-leaderboard/index.mjs           # :8790
node examples/gaming-leaderboard/player.mjs          # second terminal: random player -> submitScore -> top -> saveState -> loadState
```

One curl (let the script sign for you; the nonce changes every time): `node examples/gaming-leaderboard/player.mjs http://127.0.0.1:8790 4321 --print-only`
prints a ready-to-run `curl ... /tapeapi/v1/submitScore ...` line (see above). `saveState` is paid; in dev the provider cannot reach an escrow and returns a
signed error envelope — use `FREE_ALL=1` for local debugging.

## Dev to mainnet

1. **Mint a circuit** on TapeOut → `circuits`/`tokenId`; container = `DeWebHub.accountOf(circuits, tokenId)`.
2. **Sign the delegation** with `examples/reader-service/sign-delegation.mjs`; restart with `DELEGATION_SIG`/`DELEGATION_EXPIRES`, `CONTAINER`, `CIRCUITS`, `TOKEN_ID`, `ESCROW`, `PUBLIC_URL`, `SIGNER_KEY`, `DATA_FILE`.
3. **Publish the manifest** served at `/.well-known/tapeapi.json` to the container's DeWEB site.
4. **Register the label**: `api.tx.register({ circuits, tokenId, label: 'my-game', manifestPath })`.

Env: `PORT`, `SIGNER_KEY`, `RPC_URLS`, `QUORUM`, `DATA_FILE`, `MAX_STATE_BYTES`, `PUBLIC_URL`, `FREE_ALL` (dev). Client: `PLAYER_KEY`, `SESSION_KEY`, `CONSUMER`.
