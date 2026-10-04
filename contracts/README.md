# TapeAPI Contracts / 合约

Solidity `^0.8.24`, no external dependencies (forge-std only in tests). Not upgradeable. Zero protocol fee: `Ownable` only manages the label fee / treasury address (Directory) and the treasury address (Escrow).
不可升级。零协议费：owner 仅管理标签费与国库地址（目录）以及金库地址（托管）。

| Contract | Purpose / 用途 |
|---|---|
| `src/interfaces.sol` | Minimal `IERC20` / `IERC721` / `IDeWebHub` / `IFactory` / `IDomainBinding`, `Service` struct, custom errors, tiny two-step `Ownable`, `ECDSA.recover` |
| `src/ServiceDirectory.sol` | Service registry keyed by container; `circuits` must pass `factory.isCPU`; optional unique `bytes32` label; optional activation gate via DomainBinding; EIP-712 `Delegation` verification |
| `src/TapeAPIEscrow.sol` | Prepaid BEM escrow **v2**: one channel per (consumer, provider) — the channel balance is the cap; EIP-712 `Voucher` settlement out of that channel only, partial settlement as a credit flow; per-channel session keys (≤ 30 d, extend-only, no revoke); one consumer-side delay: 48h withdraw cooldown + 7d execution window; zero protocol fee, maintenance contribution to a treasury carved from the provider's share (constant default 1% until the circuit holder sets a value, 0 included; cap 20%). Design: `spec/TAP-22.md` §3.3. The audited v1 (shared pool + commitment accounting) is archived, uncompiled, under `archive/` |

## Build / 编译

```sh
npm install --no-audit --no-fund     # installs solc-js
npm run compile                      # -> contracts/out/ServiceDirectory.json, contracts/out/TapeAPIEscrow.json
git submodule update --init          # forge-std, pinned (once, after cloning)
forge test                           # Foundry tests in contracts/test
```

Artifacts contain `abi`, `bytecode`, `deployedBytecode`, `methodIdentifiers`. Compiled with optimizer (200 runs), `evmVersion: paris`.

### Two build systems, one of them deploys / 两套构建，只有一套上链

| Build | Command | Output | solc | `bytecodeHash` | Deployed? |
|---|---|---|---|---|---|
| Foundry, default profile | `forge build` | `contracts/out-forge/` | `0.8.28+commit.7893614a` (pinned in `foundry.toml`) | `ipfs` | **yes** |
| solc-js | `npm run compile` | `contracts/out/` | floating npm `solc` (`^0.8.28`, currently 0.8.37) | `none` | no |

The two produce **different bytecode**. `script/Deploy.s.sol` reads its creation code from
`out-forge/` and asserts the artifact's compiler and `evmVersion` before deploying, and
`scripts/verify-bscscan.mjs` builds the BscScan standard-json from that same artifact's own
metadata — so what is verified is by construction what was deployed. `contracts/out/` exists for the
ABIs and for anything that wants bytecode without Foundry; it is not what goes on chain.
两套构建产出的字节码不同；上链与验证都以 `out-forge/` 为准，`contracts/out/` 仅供 ABI 等用途。

There is also a `[profile.deploy]` in `foundry.toml` (`out = "out-deploy"`, `evm_version = "shanghai"`).
It exists only so `forge script`'s local simulation can execute the PUSH0 in BNB Chain's own
contracts; its artifacts are never deployed. Never run `forge build` with it.
`[profile.deploy]` 只为让本地模拟能执行 BNB 链合约里的 PUSH0，其产物永不上链。

## Deploy / 部署（BNB Smart Chain, chainId 56）

In short:

```sh
cd contracts && forge test && forge build          # default profile — this is what deploys
cd .. && node scripts/preflight.mjs                # read-only, 3 RPCs, exits non-zero if anything is off
cd contracts
DRY_RUN=true FOUNDRY_PROFILE=deploy forge script script/Deploy.s.sol --rpc-url $RPC_URL --sender $DEPLOYER
FOUNDRY_PROFILE=deploy forge script script/Deploy.s.sol --rpc-url $RPC_URL --account <keystore> --sender $DEPLOYER --broadcast
cd .. && node scripts/verify-bscscan.mjs --directory 0x... --hub $HUB --factory $FACTORY --domain-binding $DOMAIN_BINDING
```

Measured cost (anvil fork of mainnet, 2026-09-21): ServiceDirectory **1,698,443 gas**,
TapeAPIEscrow **1,930,621 gas**; at the then-current 0.05 gwei that is 0.000085 BNB and
0.000097 BNB respectively — about $0.14 for both.

### Mainnet addresses we depend on / 依赖的主网地址（chainId 56）

All verified live on 2026-09-21 via `eth_getCode` / `eth_call` on three independent RPCs.
全部于 2026-09-21 在三个独立 RPC 上链上核实。

| Contract | Address | Used by / 用途 |
|---|---|---|
| DeWebHub (proxy) | `0xe61A9C7213a6Aa616C246a2B569e555B417b25ee` | `accountOf` container derivation; also the EIP-712 anchor of the `Delegation` domain |
| Circuits (processor) factory | `0x68224F668083c29e9800Be2a646d42d18cedF7e2` | `isCPU` gate in `ServiceDirectory.register` |
| DomainBinding | `0x861EE183de2BBE4a6ecf9D15812C123b566a3DB7` | optional activation gate (`isContainerLive`) |
| BEM (ERC-20) | `0x5ce033b2bfca3af30b3e8c8457deaf776a8b695a` | `TapeAPIEscrow` payment token |
| SiteRegistry | `0xd006ffdd5Ae313B17729621A00999cD3C71CE5e6` | manifest reads (SDK, not a constructor arg) |
| Container opener | `0x021745DE2f42A7839d96f2d3634d0294487D81F1` | container activation (operator flow, not a constructor arg) |
| ERC-6551 registry | `0x000000006551c19487814612e58FE06813775758` | what DeWebHub derives containers through |

Known-good sample used as a live probe by both the deploy script and `scripts/preflight.mjs`:
circuit **4246** on processor #0 (`factory.cpus(0)` = `0x50A994E71615474b55559fF4F500928fbc339DD9`)
derives container **`0x86DDaEF00401E3F10418398D67D7189fc458eA95`**.

### Deployed addresses / 已部署地址

| Contract | chainId 56 | Verified on BscScan |
|---|---|---|
| `ServiceDirectory` | TODO (not deployed) | TODO |
| `TapeAPIEscrow` | TODO (not deployed — the escrow waits for real paid demand) | TODO |

### ServiceDirectory

```
constructor(address hub, address factory, address domainBinding)
```

| Arg | Mainnet value / 主网值 | Mutable after deploy? |
|---|---|---|
| `hub` | DeWebHub proxy `0xe61A9C7213a6Aa616C246a2B569e555B417b25ee` | **no — immutable** |
| `factory` | Circuits factory `0x68224F668083c29e9800Be2a646d42d18cedF7e2` — `isCPU(address) view returns (bool)`; non-zero / 电路工厂，非零 | **no — immutable** |
| `domainBinding` | `0x861EE183de2BBE4a6ecf9D15812C123b566a3DB7` to enable the activation gate, or `address(0)` to disable / 激活门槛合约，零地址关闭 | **no — immutable** |

Post-deploy state the deploy script asserts: `owner == treasury == deployer`, `labelFee == 0`,
`count() == 0`, `pendingOwner() == 0`, and `DOMAIN_SEPARATOR() == 0xa73ee348b5672f12dbc174f66a7d162c69e0d64befdba88475d9d7e3c0fd3ac7`
(chainId 56 + the canonical hub — the worked example in `spec/TAP-20.md` §6.2).
`treasury` and `labelFee` are ordinary storage and can be changed later; the three constructor args
cannot. 三个构造函数参数都是 immutable，写错只能重新部署。

`register()` reverts `NotCPU()` unless `factory.isCPU(circuits)` is true, so only factory-deployed circuits contracts can register (a home-made ERC-721 whose `ownerOf` says anything cannot squat labels or spam `count()/at()`). `update()` and `release()` are not gated.
`register()` 要求 `factory.isCPU(circuits)` 为真，否则回滚 `NotCPU()`；自制 ERC-721 无法登记。`update()` / `release()` 不查此门槛。

Deployer becomes `owner` and initial `treasury`; `labelFee` starts at 0 (and is meant to stay 0: activation fees already go to the protocol; the `isCPU` gate is what prevents squatting). After deploy:
`setLabelFee(uint256 wei)`, `setTreasury(address)`; `withdraw()` (anyone) forwards accumulated BNB to treasury.

With a non-zero `domainBinding`, `register()` with a non-zero label requires `isContainerLive(container) == true`. The check is a low-level `staticcall`: the container is live only when the call succeeds, returns at least 32 bytes and the first word is exactly `1`; a revert (older DomainBinding implementations revert for unknown containers), empty/short return data or a non-canonical word (e.g. `0x02`) counts as not live and `register` reverts with `NotLive()` — never with a panic. Label-less registration, `update()` and `release()` never consult the gate. `isLive(address)` is public for front-ends.

Holder checks (`register`, `update`, `release`, `verifyDelegation`) use a non-reverting `ownerOf` wrapper: a burned or non-existent token (OpenZeppelin-style `ownerOf` reverts) yields `address(0)`, so `register`/`update` revert `NotHolder()` and `verifyDelegation` returns false. `release(label)` may be called by **anyone** once the circuit has no holder, so a burned circuit cannot park a label forever.
持有人检查使用不回滚的 `ownerOf` 封装：已销毁 / 不存在的 token 视为零地址，`register`/`update` 回滚 `NotHolder()`；电路无持有人时 `release(label)` 任何人可调，标签不会被永久占位。

EIP-712 domain: `{ name: "TapeAPI", version: "1", chainId, verifyingContract: <this> }`
`Delegation(address container,address signer,uint64 expires)` — signer must be `circuits.ownerOf(tokenId)`.

### TapeAPIEscrow

```
constructor(address bem, address hub, address treasury)
```

| Arg | Value / 值 | Mutable after deploy? |
|---|---|---|
| `bem` | BEM ERC-20 `0x5ce033b2bfca3af30b3e8c8457deaf776a8b695a` | **no — immutable** |
| `hub` | DeWebHub proxy `0xe61A9C7213a6Aa616C246a2B569e555B417b25ee` (for `accountOf` in `setContribution`) | **no — immutable** |
| `treasury` | standard-maintenance treasury (non-zero; a multisig is strongly preferred; published in TAP-22 §6) / 标准维护金库，建议多签 | yes — `setTreasury(address)` |

The `bem` argument is the one token this v2 contract escrows. The version planned for audit takes an immutable `token` instead (one instance per token, same bytecode), and the USDT-pegged token on BNB Smart Chain is the first planned instance; BEM and WBNB are on demand. Which tokens are admitted and why: TAPI-22 §3.5 (informative; nothing here is deployed or audited).
本合约（v2）的 `bem` 参数就是它托管的那一种代币。计划送审的版本改为不可变的 `token`（每种代币一个实例，同一份字节码），首个计划实例是 BNB Smart Chain 上的 USDT 锚定币，BEM 与 WBNB 按需。哪些代币准入及原因见 TAPI-22 §3.5（说明性内容；均未部署、未审计）。

Post-deploy state the deploy script asserts: `owner == deployer`, `treasury == TREASURY`,
`pendingOwner() == 0`, `WITHDRAW_COOLDOWN == 48h`, `WITHDRAW_WINDOW == 7d`, `MAX_SESSION == 30d`,
`MAX_CONTRIBUTION_BPS == 2000`, `DEFAULT_CONTRIBUTION_BPS == 100`, the `VOUCHER_TYPEHASH`, and that `DOMAIN_SEPARATOR()` equals
`keccak256(EIP712Domain, "TapeAPIEscrow", "1", chainid, address(escrow))`. Note the anchor
difference from the directory: the escrow's voucher domain is bound to the escrow itself, while the
directory's delegation domain is bound to the **hub**.
注意两者锚点不同：托管的凭证域锚定在托管合约自身，目录的委托域锚定在 DeWebHub。

There is no protocol fee and no fee setter. The owner's only power after deploy is `setTreasury(address)` (emits `TreasuryChanged`) and nominating a successor. Ownership is two-step in both contracts: `transferOwnership(newOwner)` only sets `pendingOwner` (emits `OwnershipTransferStarted`); the nominee must call `acceptOwnership()` (emits `OwnershipTransferred`). Re-nominating replaces the nominee; nominating yourself cancels.
Providers set it themselves: the circuit holder calls `setContribution(circuits, tokenId, bps)` with `bps <= MAX_CONTRIBUTION_BPS = 2000`; the value applies to `hub.accountOf(circuits, tokenId)`. Until then `contributionOf` returns `DEFAULT_CONTRIBUTION_BPS = 100` (1%); once set, the value replaces the default for good, 0 included (storage keeps an `isSet` bit, so 0 never falls back to 100). Any address that is no circuit's container can never be set, so it always pays the default.

EIP-712 domain: `{ name: "TapeAPIEscrow", version: "1", chainId, verifyingContract: <this> }`
`Voucher(address consumer,address provider,uint256 cumulative,uint64 expires)` — unchanged from v1 (same typehash, same domain name/version, so SDK signing did not change). Signed by the consumer, or by a session key authorised **for that (consumer, provider) channel** and live at settlement (`sessionExpiry(consumer, provider, key) >= block.timestamp`). A voucher is valid while `block.timestamp <= expires`.

Constants: `WITHDRAW_COOLDOWN = 48h`, `WITHDRAW_WINDOW = 7d`, `MAX_SESSION = 30d`, `DEFAULT_CONTRIBUTION_BPS = 100`, `MAX_CONTRIBUTION_BPS = 2000`.
Storage is keyed by channel: `channelOf(consumer, provider)`, `claimedOf(consumer, provider)`, `sessionExpiry(consumer, provider, key)`, `pendingWithdraw(consumer, provider) -> (amount, requestedAt)`; plus `contributionOf(provider)` and `treasury`.
存储全部按 (消费者, 提供者) 通道分键；通道余额即该提供者可结算的上限。

## Behavioural notes / 行为说明

- `register`: `circuits` must pass `factory.isCPU`. label `0` = no label (free). A new label costs `labelFee` (excess BNB is kept). Re-registering the same container with the same label is free and only updates `manifestPath`; switching labels frees the old one and emits `Released(container, oldLabel)` before `Registered`.
- `release(label)`: frees the label; the service record stays with `label = 0`. Holder only while the circuit has a holder; anyone once it is burned.
- `fund(provider, amount)`: `transferFrom` after crediting `channelOf(msg.sender, provider)`; immediate. Reverts `ZeroAmount()` and `BadProvider()` (zero address or the escrow itself — no channel toward them can ever exist, which also closes round-2 N-02). Emits `Funded(consumer, provider, amount)`. Money in one channel is invisible to every other provider: the v1 C-01 self-dealing drain has no first step here.
- `authorizeSession(provider, key, expires)`: per channel; `now < expires <= now + MAX_SESSION` (else `Expired()` / `SessionTooLong(max)`); extend-only (`SessionShorteningNotSupported()`); `key != 0`, provider not zero / escrow. **There is no `revokeSession`.** A leaked key is bounded by that one channel's balance and by 30 days and simply expires; authorise short keys and small channels for a tighter bound. `settle` requires the session to be live AT SETTLEMENT (the H-01 rule), not to outlive the voucher.
- `settle`: anyone may call. Requires `block.timestamp <= expires`, provider not zero / escrow (`BadProvider()`), a valid signer (consumer, or a session key live on this channel), `cumulative > claimed` (`NothingToSettle()`). Pays `pay = min(cumulative - claimed, channelOf)`; `pay == 0` reverts `InsufficientBalance()`. `contribution = pay * contributionOf(provider) / 10000` goes to `treasury` (no transfer at all when it is 0), the remainder to `provider` (the service container). `claimed += pay`, `channel -= pay`. **Partial settlement is a supported credit flow**: a provider that served past the channel is paid what the channel holds, and the same voucher settles the rest after the consumer funds again. `Settled(consumer, provider, pay, contribution, bps)`, where `bps` is the rate this settlement applied. The consumer's price is unaffected; a `bps` change applies from the next settlement on, never retroactively (a voucher not yet settled is split at the rate in force when it settles).
- `requestWithdraw(provider, amount)` (`amount > 0` else `ZeroAmount()`, `amount <= channelOf` else `InsufficientBalance()`, `amount <= 2^192 - 1` else `AmountTooLarge()`) records `(amount, now)` on that channel, replacing an earlier request and restarting its clock, and emits `WithdrawRequested(consumer, provider, amount, availableAt)`. `withdraw(provider)` only inside `[requestedAt + 48h, requestedAt + 48h + 7d]`; earlier reverts `CooldownActive(availableAt)`, later reverts `WithdrawWindowClosed()` and the request must be re-made (which restarts the 48h) — so a request cannot be armed weeks ahead. Pays `min(requested, channelOf)` at execution time (settlements inside the cooldown come first), clears the request; reverts `InsufficientBalance()` and keeps the request when the channel was settled to zero.
- **The provider's protection is the cooldown, and only the cooldown.** `WithdrawRequested` is public; a provider MUST watch it for every channel it serves and settle before `availableAt`. A provider that does not is not paid for what it served against that channel once the withdrawal executes. This is the same guarantee in substance that v1's two delays gave — v1's `AllowanceDecreaseRequested` was equally a public event after which a provider that did not settle within 24h had its vouchers capped to nothing — recorded as the honest trade in `spec/TAP-22.md` and pinned by `test/Attacks.t.sol` (`test_attack_E03_*`). The reference provider (`server/src/index.js`) additionally refuses to serve against a withdraw request that is inside its lifetime (`channelOf - pendingWithdraw.amount` is the available figure, TAP-22 §3.2(4)).
  提供者的保护只有冷静期：MUST 监听 `WithdrawRequested` 并在 `availableAt` 前结算；这与 v1 的双延迟在实质上是同一保证。参考实现的提供者还会拒绝对已上膛的提现请求提供服务。
- Solvency identity, checked by `test/EscrowInvariant.t.sol` over 128,000 randomised calls: `bem.balanceOf(escrow) == Σ channelOf` exactly and `Σ channelOf + Σ paid == Σ funded − Σ withdrawn`; `claimed` is monotone; no settle pays more than the channel held; a voucher inside the channel when signed is payable in full if settled before any withdraw executes on that channel.
- Ownership: two-step (`transferOwnership` -> `acceptOwnership`) in both contracts.
- Token transfers use low-level calls and accept tokens that return `bool` or nothing (USDT style); a `false` return reverts with `TransferFailed`.
