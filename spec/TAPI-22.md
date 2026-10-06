| TAPI | 22 |
|---|---|
| Title | TapeAPI: Metered Payment Voucher and Escrow |
| Author | Bruce (@BruceLanLan) |
| Status | Experimental |
| Implementation | Not deployed (2026-09-27). `contracts/src/TapeAPIEscrow.sol` (v2; v3 since 2026-10-05: one immutable token per instance, pull treasury) is implemented and tested, and the SDK and server implement the voucher, but no escrow is deployed on BNB Chain and it needs an independent audit before it holds real funds. The live services (`11.1013.tape`, `12.1013.tape`) are free and name no escrow. Since 2026-10-05 the v3 contract implements §3.4 as written (default 100 bps, cap 2000 bps, "never set" kept apart from 0); it is still unaudited (§7). |
| Type | Standards |
| Created | 2026-09-20 |
| Revision | v2 (2026-09-21): per-(consumer, provider) channels. Supersedes the v1 shared-pool + commitment-accounting escrow; the v1 contract and its tests are archived under `contracts/archive/`. The voucher (§3.1) is unchanged. 2026-09-28, before any deployment: the §3.4 contribution defaults to 100 bps and each provider can set it from 0 to 5000 (was: default 0, 100 recommended). 2026-10-05, before any deployment: the cap is 2000 bps (20%; was 5000), directories are no longer allowed to rank or badge services by the contribution (previously allowed to rank by it), the escrow keeps "never set" (default applies) apart from "set to 0", and `Settled` carries the applied `bps`. Also 2026-10-05: new informative §3.5 (custody assets): USDT-pegged token first, admission criteria, planned changes for the audited version; the token list in §3.4 is replaced by a pointer to it. Later on 2026-10-05, factual only: the §3.3 constructor argument and view are named `token` (was `bem`), the solvency line reads `≥` (direct transfers stay in the escrow), and §3.5 and §7 record which planned items the repository contract now has. Later on 2026-10-05, specifying the escrow that goes to audit (before any deployment): `settle` accrues the contribution to `treasuryAccrued` instead of transferring it, and `claimTreasury()` (anyone) pays it to the treasury (§3.3); `setTreasury` first pays the outgoing treasury and refuses the escrow and its token as treasury (§3.4); voucher amounts are in base units of the instance's token (§3.1); every token call that does not answer success reverts `TransferFailed()`; `upto` settlement is explicitly out of scope. |
| Requires | TAPI-20, TAPI-21 |
| License | CC0-1.0 |

# TAPI-22: TapeAPI: Metered Payment Voucher and Escrow

> English is authoritative. 中文译文见下半部分，章节编号一一对应。

> **Not a TAP.** "TAPI-22" is TapeAPI's own name for this document; until 2026-09-30 it was called "TAP-22". It is not a TAP: TAP numbers are assigned by the editors of [TapeOutProtocol/TAPs](https://github.com/TapeOutProtocol/TAPs) under TAP-01 §6.1. Frozen constants that contain an old name (for example the `TAP-26/…` labels) are historical constants and never change.

RFC 2119 keywords apply.

## 1. Abstract

Defines an off-chain, cumulative payment voucher signed by a consumer and an on-chain escrow contract interface, built from independent `(consumer, provider)` channels, that lets a provider settle vouchers in the escrow instance's ERC-20 token out of the channel funded toward it. Payments go directly to the service container. The protocol charges no mandatory fee: a default maintenance contribution of 1% is carved out of the provider's own share at settlement, the consumer's price does not change, and each provider MAY set it to any value from 0 to 20% (§3.4).

## 2. Motivation

Per-call on-chain payment is too slow and too expensive for API traffic. A monotonically increasing cumulative voucher lets the provider accept thousands of calls off-chain and settle once, while the consumer's exposure toward each provider is bounded by the channel it funded toward that provider — and nothing else, because a channel is the only thing a voucher can be paid from.

## 3. Specification

### 3.1 Voucher

- Domain: `EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)` with `name = "TapeAPIEscrow"`, `version = "1"`, `chainId = 56`, `verifyingContract = <Escrow address>`.
- Primary type: `Voucher(address consumer,address provider,uint256 cumulative,uint64 expires)`.
- `VOUCHER_TYPEHASH = keccak256("Voucher(address consumer,address provider,uint256 cumulative,uint64 expires)") = 0x8e017cc56e9f2cb1f0fd1af4419f7c77b8d3f92099263f2b8aba4ba44cf50407`.
- `structHash = keccak256(abi.encode(VOUCHER_TYPEHASH, consumer, provider, cumulative, expires))`; `digest = keccak256(0x1901 ‖ DOMAIN_SEPARATOR ‖ structHash)`.
- `provider` MUST be the service container (TAPI-20 §3.1). `cumulative` is the total amount, in base units of the escrow instance's token (`token()`, §3.5), the consumer owes this provider, and MUST be non-decreasing across vouchers for the same `(consumer, provider)`.
- The signer MUST be `consumer`, or a session key authorised by `consumer` **for this `(consumer, provider)` channel** via `authorizeSession(provider, key, expires)` that is live at settlement: `sessionExpiry(consumer, provider, signer) ≥ block.timestamp`. The session does not have to outlive the voucher. There is no revoke: a key is bounded by that one channel's balance and by `MAX_SESSION` (30 days) and simply expires (§8).
- A voucher is valid while `block.timestamp ≤ expires` (inclusive); this is the single boundary used by the escrow, providers and the SDK.

Wire form inside a TAPI-21 request:

```json
"voucher": { "consumer": "0x..", "provider": "0x..", "cumulative": "123", "expires": 1758400000, "sig": "0x..", "signer": "0x.." }
```

### 3.2 Provider Checks

Before serving a priced method the provider MUST verify:

1. `sig` recovers to `signer`, and `signer` is `consumer` or a session key with `sessionExpiry(consumer, provider, signer) ≥ block.timestamp` — note the `provider` argument: a key authorised for another channel of the same consumer is not authorised here;
2. `now ≤ expires` — the same boundary as `settle` (§3.1). Providers SHOULD additionally require enough margin to get a settlement mined before `expires`, and MAY enforce a minimum remaining life on both `expires` and the signing session's expiry; a provider that does so MUST report the threshold in `BAD_VOUCHER` as `data.minVoucherLifeS` (the reference runtime defaults to 300 s and also publishes it in `/tapeapi/v1/health`), and its settler cadence MUST be shorter than that value;
3. `cumulative > claimedOf(consumer, provider)` and `cumulative ≥ last + price` where `last = max(lastCumulative[consumer][provider], claimedOf(consumer, provider))`. `lastCumulative` is the provider's own record; it MUST be reconciled with the on-chain `claimedOf` (a restarted or scaled-out provider MUST NOT accept a voucher at or below `claimedOf`: it can never settle);
4. on-chain, `cumulative − claimedOf(consumer, provider) ≤ available`, where `available = channelOf(consumer, provider) − pendingWithdraw(consumer, provider).amount` while a withdraw request on that channel is inside its lifetime (`now ≤ requestedAt + WITHDRAW_COOLDOWN + WITHDRAW_WINDOW`, §3.3.1) and `channelOf(consumer, provider)` otherwise. The channel is the cap; there is no allowance. The subtraction is the provider-side half of the E-03 defence (§8): inside the cooldown the provider can still settle ahead of the request, but once the request is executable the requested amount can leave in the same block as the settlement, so serving against it is extending credit with no cover. A provider that knowingly extends credit (§3.3.1, *Partial settlement*) MAY relax this check for that consumer.

The provider MUST answer `PAYMENT_REQUIRED` only when a priced method is called without a voucher, and `BAD_VOUCHER` for any voucher that is present but not acceptable (signature, expiry, stale or insufficient cumulative, over the channel). Every `BAD_VOUCHER` and every `PAYMENT_REQUIRED` MUST carry `data.price`: the per-call price the provider is charging for this method, as a decimal string of BEM base units (10⁻⁸ BEM; e.g. `"10000"` for `priceBEM: "0.0001"`), with no sign, fraction or leading zeros. Without it a consumer cannot tell a stale price from a stale counter, and a consumer holding a manifest from before a price rise retries at the old price for ever (TAPI-20 §3.6); the consumer treats `data.price` as a hint only and re-reads the manifest from the chain before paying. When the rejection is a stale cumulative the error `data` MUST also carry `lastCumulative`, `onChainClaimed`, and — when the provider holds one — the consumer's own signed voucher for that cumulative (`voucher: { cumulative, expires, sig }`). A client MUST NOT advance its local counter on a bare number: it MUST first verify either that `onChainClaimed` is at least the reported figure, which anyone can check on chain, or that the attached voucher recovers to the consumer or to a session key the consumer authorised. Adopting an unproved figure lets a hostile provider name an arbitrary amount, have the client sign a voucher for it, and settle it up to the channel — draining the consumer's channel in a single call for the price of one identity. The provider MUST retain the highest valid voucher per `(consumer, provider)` for settlement, and SHOULD settle before `min(expires, sessionExpiry(consumer, provider, signer))` (both bounds still apply: the voucher must not have expired and the session must still be live).

### 3.3 Escrow Interface

Non-upgradeable. `Ownable` exists only to rotate the treasury address. The treasury role includes the contributions accrued but not yet claimed (`treasuryAccrued`), and a rotation first pays them to the outgoing treasury (§3.4), so the owner cannot redirect what a treasury able to receive has already earned; beyond that the owner has no power. All balances, claims, sessions and withdraw requests are keyed by `(consumer, provider)`; nothing is shared between two providers of the same consumer.

```
constructor(address token, address hub, address treasury)        // all non-zero; treasury ≠ token, ≠ escrow (BadTreasury); token = the one ERC-20 of this instance (§3.5); hub = DeWebHub for accountOf
fund(address provider, uint256 amount)                           // transferFrom(msg.sender); channel[msg.sender][provider] += amount; immediate
requestWithdraw(address provider, uint256 amount)                // amount ≤ channel; records (amount, now), replacing an earlier request
cancelWithdraw(address provider)                                 // clears the caller's pending request on that channel
withdraw(address provider)                                       // inside [requestedAt + 48 h, requestedAt + 48 h + 7 d]; pays min(requested, channel)
authorizeSession(address provider, address key, uint64 expires)  // per channel; now < expires ≤ now + 30 d; extend-only; no revoke
setContribution(address circuits, uint256 tokenId, uint16 bps)   // holder only; provider = hub.accountOf(circuits, tokenId); 0 ≤ bps ≤ 2000
settle(address consumer, address provider, uint256 cumulative, uint64 expires, bytes sig)
claimTreasury() → amount                                         // anyone; pays the whole treasuryAccrued to the current treasury
setTreasury(address) / transferOwnership(address) / acceptOwnership()   // owner / nominee only; nothing else is owner-gated; setTreasury pays the outgoing treasury first (§3.4)
channelOf(consumer, provider), claimedOf(consumer, provider), sessionExpiry(consumer, provider, key),
pendingWithdraw(consumer, provider) → (amount, requestedAt), contributionOf(provider), treasury, treasuryAccrued, hub, token,
DEFAULT_CONTRIBUTION_BPS (= 100), MAX_CONTRIBUTION_BPS (= 2000), WITHDRAW_COOLDOWN (= 48 h), WITHDRAW_WINDOW (= 7 d), MAX_SESSION (= 30 d),
DOMAIN_SEPARATOR, VOUCHER_TYPEHASH, voucherDigest   // views
events: Funded(consumer, provider, amount), WithdrawRequested(consumer, provider, amount, availableAt),
        WithdrawCancelled(consumer, provider), Withdrawn(consumer, provider, amount), SessionAuthorized(consumer, provider, key, expires),
        Settled(consumer, provider, paid, contribution, bps), ContributionSet(provider, bps), TreasuryChanged(old, new),
        TreasuryClaimed(treasury, amount), OwnershipTransferStarted(old, new), OwnershipTransferred(old, new)
errors: ZeroAddress, ZeroAmount, BadProvider, BadTreasury, InsufficientBalance, NoPendingWithdraw, CooldownActive(uint64 availableAt),
        WithdrawWindowClosed, AmountTooLarge, Expired, SessionTooLong(uint64 max), SessionShorteningNotSupported,
        BadSignature, NothingToSettle, NotHolder, ContributionTooHigh(uint16 bps), TransferFailed, Reentrancy,
        NotOwner, NotPendingOwner
```

`fund` MUST revert `ZeroAmount()` for `amount == 0` and `BadProvider()` when `provider` is the zero address or the escrow itself; it MUST credit `channelOf(msg.sender, provider)` before pulling the tokens and emit `Funded`. A channel toward a provider that will never settle can only be recovered by the consumer through `requestWithdraw` / `withdraw`.

`settle` MUST: be callable by anyone; require `block.timestamp ≤ expires` (`Expired()`); revert `BadProvider()` when `provider` is the zero address or the escrow itself; recover the signer and accept it only if it is `consumer` or `sessionExpiry(consumer, provider, signer) ≥ block.timestamp` (`BadSignature()` otherwise); require `cumulative > claimed[consumer][provider]` (`NothingToSettle()`); compute `delta = cumulative − claimed[consumer][provider]` and `paid = min(delta, channel[consumer][provider])`, and require `paid > 0` (`InsufficientBalance()`); compute `bps = contributionOf(provider)` as it stands at this settlement and `contribution = paid × bps / 10000`; set `claimed += paid` and `channel −= paid`; add `contribution` to `treasuryAccrued`; transfer `paid − contribution` to `provider`; emit `Settled(consumer, provider, paid, contribution, bps)`. `settle` MUST NOT transfer the contribution to `treasury`, so a treasury that cannot receive the token never blocks a settlement. `paid < delta` is **partial settlement**, a supported flow (§3.3.1): `claimed` advances by what was paid, and the same voucher MAY be settled again for the remainder, until `expires`, once the channel has been funded again.

`claimTreasury()` MUST be callable by anyone; the recipient is always the current `treasury`, so the caller chooses only the moment. It MUST revert `ZeroAmount()` when `treasuryAccrued` is 0; otherwise it sets `treasuryAccrued` to 0, transfers the previous value to `treasury`, emits `TreasuryClaimed(treasury, amount)` and returns the amount. When the transfer fails it MUST revert `TransferFailed()` and change nothing; settlements are unaffected, and the accrual stays until it can be paid (§3.4, treasury rotation).

A token call made by the escrow (`fund`, `withdraw`, `settle`, `claimTreasury`) counts as successful only if it does not revert and returns either nothing, from an address that has code, or at least 32 bytes whose first word is 1; any other outcome, including `false` and a return of 1 to 31 bytes, reverts the call with `TransferFailed()`.

#### 3.3.1 Consumer-side delay (provider protection)

There is exactly one consumer action that can shrink what a provider is able to settle, and it is delayed:

- **Withdraw.** `requestWithdraw(provider, amount)` requires `amount > 0` (`ZeroAmount`), `amount ≤ channelOf(msg.sender, provider)` (`InsufficientBalance`) and `amount ≤ 2^192 − 1` (`AmountTooLarge`); it records `(amount, requestedAt = now)`, replacing any earlier request on that channel and restarting its clock, and emits `WithdrawRequested(consumer, provider, amount, availableAt = now + WITHDRAW_COOLDOWN)`. `withdraw(provider)` MUST succeed only while `requestedAt + WITHDRAW_COOLDOWN ≤ block.timestamp ≤ requestedAt + WITHDRAW_COOLDOWN + WITHDRAW_WINDOW`; before that it reverts `CooldownActive(availableAt)`, after that `WithdrawWindowClosed()` and the request has to be re-made (restarting the cooldown), so a request cannot be armed weeks ahead. It pays `min(amount, channelOf)` **at execution time** — settlements inside the cooldown come first — clears the request, and emits `Withdrawn`; when the channel has been settled to zero it reverts `InsufficientBalance()` and leaves the request in place. A request that was clamped is consumed in full; the remainder needs a new request. `cancelWithdraw(provider)` clears the caller's pending request at any time (`NoPendingWithdraw()` when there is none) and emits `WithdrawCancelled(consumer, provider)`; it can only relieve the provider, so it has no delay.
- **The provider's protection is the cooldown, per request.** `WithdrawRequested` is a public event. A provider MUST watch it for every channel it serves and settle everything it is owed on that channel before `availableAt`. "Before" is literal: at exactly `availableAt` both `settle` and `withdraw` succeed and transaction order decides who is paid, so a provider that waits for that second has already entered a race it can lose (both edges are pinned by `contracts/test/ClockBoundaries.t.sol`). Provider tooling SHOULD aim to settle well inside the cooldown, and an operator SHOULD NOT let a provider stay offline for more than half of it. The 48 h guarantee is scoped to the *request*, not to the channel: `fund` does not restart it, so a top-up made while a request is alive is withdrawable the moment that request becomes executable, up to the announced amount. Settling before `availableAt` is therefore not sufficient on its own; a provider MUST also refuse to serve against a live request beyond `channelOf − pendingWithdraw.amount` (§3.2(4)), and that subtraction is load-bearing, not advisory; a provider that does not is not paid for what it served against that channel once the consumer executes the withdrawal. This is identical in substance to the guarantee the v1 escrow gave: there, an allowance decrease was equally a public event (`AllowanceDecreaseRequested`) after which a provider that did not settle within 24 h had its vouchers capped to nothing. Both designs reduce to "a public event plus a fixed window in which the provider MUST act"; v2 has one such event instead of two, and a 48-hour window instead of 24. The reference provider serves at most `channelOf − pendingWithdraw.amount` while a request is alive (§3.2(4)); watching `WithdrawRequested` and settling before `availableAt` is the operator's job (the runtime exposes `pendingSettlements()`, whose deadline is `min(expires, sessionExpiry)`, `dueSettlements()`, which lists what must be settled now (deadline within a margin, or a withdraw request armed), and `settleTx()`; the runtime holds no wallet, and `examples/_lib/sendtx.mjs` is a settler loop that signs and sends those transactions).
- **Fund** only adds and is immediate. **Sessions** (`authorizeSession(provider, key, expires)`) require `key ≠ 0`, `provider` neither zero nor the escrow, `now < expires ≤ now + MAX_SESSION` (`Expired` / `SessionTooLong(max)`), and are extend-only: a value below the current expiry reverts `SessionShorteningNotSupported()`. There is no revoke. A consumer who wants a tighter bound authorises a shorter key or funds a smaller channel; both are visible on-chain before the provider serves.
- **Partial settlement is a credit flow, not a defence.** A provider that keeps serving past `channelOf − claimedOf` has chosen to extend credit; the escrow pays what the channel holds and the rest when the consumer funds again. Providers that do not wish to extend credit enforce §3.2(4) and stop serving at the channel.
- **Ownership.** Two-step: `transferOwnership(newOwner)` only nominates (`OwnershipTransferStarted`); the nominee's `acceptOwnership()` completes it (`OwnershipTransferred`).

Solvency (checked by the reference invariant suite): `token.balanceOf(escrow) ≥ Σ channelOf(c, p) + treasuryAccrued`, `Σ channelOf + Σ paid == Σ funded − Σ withdrawn`, and `Σ Settled.contribution == treasuryAccrued + Σ TreasuryClaimed.amount`. The relation is `≥`, not `==`: anyone can transfer tokens to the escrow directly, such a donation stays there (there is no sweep), and nothing in the escrow relies on equality.

### 3.4 Maintenance Contribution (No Mandatory Fee)

- **No operator fee.** The escrow MUST NOT charge a fee of its own and MUST NOT expose any operator-settable rate, pause, or access to user balances. The only rate in the contract is the provider's contribution, and only the provider controls it.
- **Default 100 bps, set by the provider.** Until a provider has set a value, `contributionOf(provider)` MUST return `DEFAULT_CONTRIBUTION_BPS = 100` (1%). The default is a constant of the contract, not a parameter: nobody can change it after deployment. The contribution MAY be changed only by the current holder of the service circuit via `setContribution(circuits, tokenId, bps)`, where `provider = hub.accountOf(circuits, tokenId)`; any value from 0 (no contribution) to `MAX_CONTRIBUTION_BPS = 2000` (20%, also a constant) is accepted, and once set, that value, 0 included, replaces the default. The escrow MUST keep "never set" apart from "set to 0" in storage, so that a provider set to 0 reads 0 and contributes nothing, never the default. The escrow MUST enforce `bps ≤ MAX_CONTRIBUTION_BPS` and MUST emit `ContributionSet(provider, bps)`. A circuit transfer moves this right to the new holder.
- **What it funds, and no penalty for 0.** The contribution funds standard maintenance: specification upkeep, the reference implementation, audits, and directory operation. A provider at 0 bps MUST receive identical treatment from the escrow, the SDK, and other providers; directories MAY display the value, but MUST NOT use it to rank or order services or to give them any badge or mark, and MUST NOT withhold functionality because of it.
- **Carved from the provider's share.** The contribution is deducted at settlement from what the provider would otherwise receive; the consumer's price is unchanged. A change to `bps` applies to settlements after the change, never retroactively: what was settled before is never recomputed, and a voucher not yet settled is split at the rate in force when it settles. The contribution is rounded down; when it rounds down to 0 nothing is accrued.
- **Treasury.** `treasury` is set in the constructor and MUST be published in §6 (and the repository README) before Final. It MAY be changed only by the owner via `setTreasury`, which MUST emit `TreasuryChanged(old, new)`, MUST reject the zero address (`ZeroAddress()`), and MUST reject the escrow itself and its token (`BadTreasury()`; the constructor refuses them too), since a claim to either would strand the accrual. The treasury role includes what is accrued but not yet claimed. When something is accrued, `setTreasury` MUST first attempt `claimTreasury()` for the outgoing treasury, so that a rotation cannot redirect what that treasury has earned; when the attempt fails it is rolled back in full and the rotation MUST still succeed, leaving the accrual for the new treasury. That is how a treasury that cannot receive the token (frozen, or a contract that rejects it) is replaced without loss and can never block its own replacement. Rotating to the current treasury changes nothing and emits nothing. Beyond rotation the owner MUST have no other power: no fee switch, no pause, no access to channels or user balances, no ability to change any provider's `bps` or the default, and no way to pay the accrual to anyone but `treasury`.
- **Alternative deployments.** Any escrow implementing §3.1–§3.3 is conforming; it MAY omit `setContribution` / `contributionOf`, in which case clients MUST treat the contribution as 0. A service selects its escrow via `manifest.payment.escrow`; clients MUST use that address and MUST NOT assume a canonical deployment. If the community ever wants a uniform protocol fee, the path is a new TAP and a new escrow deployment, never a change to an existing one.

**The version that goes to audit (informative).** The escrow that will be audited and deployed holds one ERC-20 token per instance on BNB Smart Chain, the USDT-pegged token first, with BEM, WBNB and (through WBNB) BNB on demand (§3.5). §3.1–§3.4 apply to every instance, with amounts in base units of that instance's token. `upto` settlement by measured usage is not implemented and not specified in this revision, and it is not part of the audit scope. Until an escrow is deployed, no call is charged anything.

### 3.5 Custody assets (informative)

Experimental, not deployed, not audited. This subsection records which token the escrow that goes to audit is planned to hold, how a token is admitted, and what that means for the contract and the SDK. It specifies no interface: §3.1–§3.4 apply to every instance. The evidence is two rounds of read-only on-chain evaluation (2026-10-04) against three independent RPC operators, the second round re-checking the first.

**Which asset (decision of 2026-10-05).** The first supported instance holds the USDT-pegged token on BNB Smart Chain: Binance-Peg "BSC-USD", `0x55d398326f99059fF775485246999027B3197955`. It is issued by Binance, not by Tether, and its `name()` reads "Tether USD", so an SDK or console SHOULD show it as "USDT (Binance-Peg)" together with the address. BEM, WBNB and BNB (through WBNB) are planned on demand, from the same bytecode, one instance per token, with the token an immutable constructor argument; they are not part of the first deployment. No contract holds a token table that an owner can edit.

**Admission criteria.** A token is eligible for an instance only if every item holds. Each is checkable on chain or against verified source, and the result is recorded per instance.

1. Not upgradeable: not a proxy (EIP-1967, EIP-1822 and beacon slots empty), no `upgradeTo*`, no `DELEGATECALL` or `SELFDESTRUCT` in its runtime code. A proxy fails whoever holds the admin key; an admin that is a single externally owned account is the extreme case.
2. No function that freezes, pauses or blacklists an address or burns another address's balance, or none that anyone can reach (a scan of the dispatch selectors plus a simulated call from the owner or admin account).
3. Plain ERC-20 transfers: no fee on transfer, no rebase, one entry point for balances, no receiver hook; `transfer` and `transferFrom` return `true` or nothing; a transfer into a contract address succeeds (simulated, including `approve` + `transferFrom`, on at least two operators).
4. `decimals` fixed, read from the token's own `decimals()`, and 8 ≤ `decimals` ≤ 18.
5. Verified source that matches the deployed bytecode, and a published table of who can mint, upgrade, pause or freeze (externally owned account, multisig or contract, with the threshold), with reads that agree across at least two operators.

Mint authority and issuer backing are value risk, not lock-up risk: they are disclosed per instance and do not decide admission. Items 1 and 2 are not relaxed. The reason is the shape of the escrow: one instance is one address holding every channel of its token, and it has no rescue path by design. A freeze of that address stops `fund`, `settle` and `withdraw` on every channel at once. A pause is worse: `requestWithdraw` does not touch the token, so a withdrawal cooldown can run out while every provider's `settle` reverts, and when the pause ends the consumer's `withdraw` and the provider's `settle` race for the same funds. Pausable tokens are therefore excluded, not handled in the contract.

**Why the USDT-peg qualifies (evaluation of 2026-10-04).**

- Item 1: 4,413 bytes of runtime code; every proxy slot is zero; no `DELEGATECALL`, `SELFDESTRUCT` or `CALL` opcode (so no receiver hook); the same code hash on three operators.
- Item 2: all 30 `PUSH4` constants in the bytecode are accounted for: 20 dispatch selectors (ERC-20 with `increaseAllowance` and `decreaseAllowance`, `mint(uint256)`, `burn(uint256)`, `owner`, `getOwner`, `renounceOwnership`, `transferOwnership`, and the public `_name`, `_symbol` and `_decimals` getters) and 10 constants that are not selectors (a compiler metadata marker, a mask, revert-string fragments, bytes inside a 24-byte constant). None is a freeze, pause, blacklist, rescue or upgrade function. The owner is a single externally owned account (`0xF68a4b64162906efF0fF6aE34E2bB1Cd42FEf62d`) that can mint to itself and burn its own tokens and nothing else: a simulated `mint` from the owner credits only the owner, from anyone else it reverts, and there is no `burnFrom` and no `mint(address,uint256)`.
- Item 3: simulated `transfer` and `approve` + `transferFrom` from a liquidity pool into a contract address and into an externally owned account return `true` and move both balances by exactly the amount; a second hop between two accounts is exact too.
- Item 4: `decimals()` is 18, not the 6 of the token of the same name on Ethereum.
- Item 5, still open: verification of the source on the block explorer and the concentration of holders have not been checked, and both are required before any deployment.

What remains is value risk: a claim on reserves held off chain by the issuer, and one key that can mint without limit, so the token can lose its peg while the escrow keeps working. The exposure is asymmetric: on a depeg a provider can settle at any moment, while a consumer must `requestWithdraw` and wait out the 48-hour cooldown, which is one more reason for modest channels (§8).

**Not admitted.**

| Token | Why not (failed items) |
|---|---|
| USDC (Binance-Peg) on BNB Chain, `0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d` | Transparent proxy whose admin is a single externally owned account; `upgradeTo` takes effect at once with no time lock, so any audit is void the moment it is used (1) |
| USD1 on BNB Chain, `0x8d0D000Ee44948FC98c9B98A4FA4921476f08B0d` | Upgradeable (multisig admin); `freeze` blocks transfers into and out of a frozen address, `transferFrom` into it included, and `pause` stops all transfers; neither has a time lock (1, 2) |
| FDUSD on BNB Chain, `0xc5f0f7b66764F6ec8C8Dff7BA683102295E16409` | The same as USD1 (1, 2) |
| USD₮0 on X Layer | 6 decimals; upgradeable proxy; a block list whose entries' balances can be destroyed (1, 2, 4) |

Also not planned: Binance-Peg BUSD, ETH and DAI (no custody use), and lisUSD (upgrade time lock of one day, shorter than the 48-hour cooldown). Issuer-native USDC and USDT, where they exist on a chain, carry issuer blacklists by design and would fail item 2.

**Prices and amounts.** The default unit is USDT. Escrowed amounts (`fund`, `channelOf`, a voucher's `cumulative`, a withdrawal) are in the token's own base units, as its `decimals()` defines them: the USDT-peg has 18, so 10 USDT is `10000000000000000000`. An SDK and the documentation SHOULD read `decimals()` from the token and SHOULD NOT hard-code the 8 decimals of BEM into a custody amount; that convention belongs to `priceBEM`, which stays exactly as it is for compatibility. No conversion between tokens is ever made: an instance counts only its own token. Prices in several tokens (a `prices` map keyed by token address), how a manifest lists several escrows, and the form of `data.price` for a token other than BEM are not yet specified.

**Client behaviour (experimental).** An SDK SHOULD, by default, build `approve` and `fund` transactions only for escrows on a list of audited deployments (shipped with the SDK or supplied by the caller), and SHOULD require an explicit opt-in for any other escrow. `approve` gives an escrow the right to pull tokens, and a hostile manifest can name a contract that reports a real token's address while its `fund` takes everything approved. No escrow is deployed, so the list is empty today. The `payment.escrow` address a service names still decides which escrow a voucher is signed for (§3.4).

**Planned for the version that goes to audit** (status in the repository contract, which is neither audited nor deployed):

- Done: the constructor argument is an immutable `token` (§3.3); one instance per token, the same bytecode. The contract never reads `decimals()`.
- Done: solvency is stated as `token.balanceOf(escrow) ≥ Σ channelOf(c, p) + treasuryAccrued`, not `==` (§3.3): anyone can transfer tokens straight to the escrow, and such a donation stays there (no sweep, by design). The invariant suite has a direct-transfer case.
- Done and specified (§3.3, §3.4): the contribution is accrued to the treasury (`treasuryAccrued`) and paid out to the current treasury by a separate call that anyone can make (`claimTreasury()`, event `TreasuryClaimed`), instead of being transferred inside `settle`, so that a treasury that cannot receive the token can never block a provider's settlement. A treasury rotation pays the outgoing treasury first, and leaves the accrual to the new treasury only when that payment fails.
- No pause, and none to handle: pausable tokens are not admitted (above).
- Decided: the voucher does not name the token. `verifyingContract` already pins a voucher to one escrow and an escrow's token is immutable, so a voucher cannot be replayed against another token; and a client that computes `cumulative` with the wrong decimals is not helped by an extra field. The reference SDK is instead to read the escrow's `token()` and `decimals()` before it builds `approve` or `fund` or signs, and to refuse an escrow whose token is not the one it expects (not yet implemented; required before any deployment).

**Native BNB is not a custody asset.** The escrow holds ERC-20 only, and BNB is held as WBNB, which the payer wraps (`WBNB.deposit`) before `approve` and `fund`; the contract never unwraps. Two tests on 2026-10-04 (state override and `eth_estimateGas`) show why. A service container accepts native BNB only when the sender supplies enough gas (a plain transfer needs about 32,000 gas in total, and a push with 2,300 gas fails). WBNB's `withdraw` pushes native BNB with exactly 2,300 gas, so a container cannot unwrap WBNB itself: the call reverts, while the same call from an ordinary address succeeds. WBNB received by a container has to be moved to the holder's wallet and unwrapped there. Native BNB remains a way to top up a container directly, with enough gas; it is a top-up path, not an escrowed asset.


## 4. Rationale

Cumulative vouchers need no nonce and tolerate lost messages: the latest one supersedes all earlier ones. Settling to the container means revenue follows the circuit on transfer. A channel per `(consumer, provider)` makes the cap and the funds the same thing: there is no allowance to lower, no shared balance for two providers to race over, and no second exit through which a consumer could pay itself out of money an honest provider has already earned — the v1 Critical (C-01 of the pre-deployment audit) is not defended against but inexpressible. That removes the allowance-decrease delay, commitment accounting, lazy sync, the allowance ceiling, the revoke delay and settlement clamping, and leaves a single delay — the withdraw cooldown — whose guarantee is the same one v1's two delays gave (§3.3.1). Session keys keep the consumer's main key out of the browser; scoping them to a channel means a leaked key is bounded by that channel and by `MAX_SESSION`, which is why a revoke is not needed. Partial settlement becomes an honest feature: a provider can extend credit to a consumer it trusts and be paid when the channel is refilled.

## 5. Backwards Compatibility

Adds nothing to `SPEC.md`; no change to name grammar or §15.1 invariants. TAPI-21 envelopes without a voucher remain valid for free methods. The voucher type, domain and `VOUCHER_TYPEHASH` are unchanged from v1, so signing code did not change; the escrow ABI did (`fund` / `requestWithdraw(provider, …)` / `withdraw(provider)` / `authorizeSession(provider, key, expires)` / `channelOf` / three-argument `sessionExpiry` / two-argument `pendingWithdraw`), and the v1 escrow was never deployed. The §3.4 default changed from 0 to 100 bps on 2026-09-28, before any escrow was deployed or any call was paid for.

## 6. Test Vectors

| Item | Value |
|---|---|
| `VOUCHER_TYPEHASH` | `0x8e017cc56e9f2cb1f0fd1af4419f7c77b8d3f92099263f2b8aba4ba44cf50407` |
| `keccak256("TapeAPIEscrow")` | `0x9e119fcf121b28516e9297f2c41bbb6b5899ca62f3f2122145a86c0b2ddf863a` |
| Reference escrow address / `treasury` | TODO (not deployed) |
| Worked voucher digest | `spec/vectors/tapi-22-voucher.json`, checked independently by `spec/vectors/verify.py` and by the Solidity suite |

## 7. Reference Implementation

`contracts/src/TapeAPIEscrow.sol` (v1 archived as `contracts/archive/TapeAPIEscrow.v1.sol`); regression suite `contracts/test/Attacks.t.sol` (every audited v1 attack replayed against v2) and `contracts/test/EscrowInvariant.t.sol` (solvency, monotone `claimed`, no over-payment, in-range vouchers payable in full inside the cooldown). SDK `api.payer` (accepts `sessionExpiry` only to refuse issuing once the session has lapsed; `voucher.expires` is bounded by `ttl` alone), `api.tx.fund / requestWithdraw / cancelWithdraw / withdraw / authorizeSession(provider, key, expires) / settle / setContribution`, `api.chain.escrow.channelOf / claimedOf / sessionExpiry / pendingWithdraw`, and `svc.contribution` from `api.resolve`; server voucher verification reads `channelOf`, `claimedOf` and `pendingWithdraw(consumer, provider)` per §3.2, `pendingSettlements` / `settleTx`, and `provider.contribution()` (not exposed in `/tapeapi/v1/health`). Not deployed: see the header. Since 2026-10-05 the v3 contract implements §3.4 as written: `DEFAULT_CONTRIBUTION_BPS = 100`, `MAX_CONTRIBUTION_BPS = 2000`, "never set" kept apart from "set to 0", and the applied `bps` in `Settled`. It is still unaudited; the escrow version that goes to audit and deployment builds on it with the planned items noted under §3.4 and §3.5, and only that version will be audited and deployed. The repository contract already has the items §3.5 marks as done or implemented, including the pull treasury (§3.3, §3.4).

## 8. Security Considerations

- **The provider's protection is the 48-hour cooldown.** It MUST watch `WithdrawRequested` for every channel it serves and settle inside the cooldown; a provider that does not is not paid for what it served against that channel once the withdrawal executes. This is identical in substance to v1's guarantee, where the allowance-decrease request was the public event and 24 h the window. The trade is deliberate: one public event and one window instead of two. Providers SHOULD settle when the unsettled delta exceeds a threshold, MUST settle before `min(expires, sessionExpiry(consumer, provider, signer))`, and SHOULD stop serving a consumer whose withdraw request on their channel is inside its lifetime (§3.2(4)).
- **Front-running a settlement.** `requestWithdraw` is the only consumer action that can shrink a channel, and it does nothing for 48 h; `fund` only adds, `authorizeSession` only extends, and there is no revoke. A settlement submitted promptly after `WithdrawRequested` therefore always succeeds. A withdraw request that is not executed within its 7-day window lapses.
- **A channel is the whole exposure, in both directions.** Consumer exposure toward a provider is exactly `channelOf(consumer, provider)`; a malicious provider cannot claim more, and cannot touch any other channel of the same consumer. Consumers SHOULD fund channels modestly and top them up rather than parking a large balance with one provider.
- **A leaked session key is bounded by one channel and by `MAX_SESSION`.** A key is authorised per `(consumer, provider)` and cannot be authorised more than 30 days ahead; what it can sign is limited to that channel's balance, and it simply expires. There is no revoke; consumers who want a tighter bound SHOULD use short-lived keys and small channels. Nothing binds a voucher to its issue time (pre-deployment audit, round 2, N-03): re-authorising a key that once signed unsettled vouchers revives them, bounded by `cumulative − claimedOf` on that one channel. Consumers SHOULD use a fresh key per engagement rather than re-authorising an old one.
- **Partial settlement is a supported credit flow.** `settle` pays `min(cumulative − claimedOf, channelOf)` and the same voucher settles the remainder after a top-up. A provider that serves past the channel has chosen to extend credit; the escrow neither prevents nor guarantees it.
- **Self-dealing is harmless.** A consumer MAY fund a channel toward itself and settle it back; that moves only its own money and cannot reach any other channel. There is no shared pool for a second exit to drain.
- Boundary: a voucher is valid while `block.timestamp ≤ expires`; all three of escrow, provider and SDK use this inclusive bound.
- `chainId` and `verifyingContract` prevent cross-chain and cross-escrow replay. A voucher for one escrow is meaningless in another.
- The contribution can only reduce the provider's own payout and is capped at 20%; it can never increase what a consumer pays or move consumer channels. The 1% default is a constant fixed at deployment, so nobody can raise it later. Treasury rotation is the owner's sole power and is always visible on-chain through `TreasuryChanged`; it cannot take an unclaimed accrual away from a treasury that can receive the token, because the rotation pays the outgoing treasury first.
- The rewrite has been through the regression suite of every previously found attack but MUST pass a fresh independent adversarial audit before it is considered deployable, and is deployed only when there is real paid demand.

## 9. Copyright

Copyright and related rights waived via CC0-1.0.

---

# TAPI-22：TapeAPI：计量支付凭证与托管（中文译文）

> 英文为权威文本，本译文与英文章节一一对应。

> **不是 TAP。** “TAPI-22”是 TapeAPI 给本文档起的名字，2026-09-30 之前叫“TAP-22”。它不是 TAP：TAP 编号由 [TapeOutProtocol/TAPs](https://github.com/TapeOutProtocol/TAPs) 的编辑按 TAP-01 §6.1 分配。含有旧名字的冻结常量（例如 `TAP-26/…` 标签）是历史常量，永不改变。

> **实现状态（2026-09-27）：** 未部署。`contracts/src/TapeAPIEscrow.sol`（v2；自 2026-10-05 起为 v3：每个实例一种不可变代币、拉取式金库）已实现并有测试，SDK 与服务端实现了凭证，但 BNB Chain 上没有部署任何托管合约，在它持有真实资金之前需要一次独立审计。运行中的服务（`11.1013.tape`、`12.1013.tape`）免费，不指定托管合约。自 2026-10-05 起，v3 合约按本文 §3.4 实现（默认 100 bps、上限 2000 bps、区分"从未设定"与 0）；它仍未经审计（§7）。

> **状态：** Experimental（实验性，见 [TAPI-1](TAPI-1.md) §4.1）：不在 TapeAPI 1.0 的稳定承诺之内，可能不兼容地修改或撤回。

RFC 2119 关键词适用。

## 1. 摘要

定义由消费者签署的链下累计支付凭证，以及由相互独立的 `(consumer, provider)` 通道构成的链上托管合约接口，允许提供者从消费者充给它的那条通道中以该托管实例的 ERC-20 代币结算凭证。款项直接进入服务容器。协议不收取强制费用：结算时默认从提供者自己的份额中划出 1% 作为维护贡献，消费者的价格不变；每个提供者 MAY 把它设为 0 到 20% 之间的任意值（§3.4）。

## 2. 动机

按次链上支付对 API 流量而言过慢且过贵。单调递增的累计凭证使提供者可在链下接受数千次调用后一次结算，同时消费者对每个提供者的风险敞口由其充给该提供者的通道限定——且仅由它限定，因为通道是凭证唯一可能的支付来源。

## 3. 规范

### 3.1 凭证

- 域：`EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)`，其中 `name = "TapeAPIEscrow"`、`version = "1"`、`chainId = 56`、`verifyingContract = <Escrow 地址>`。
- 主类型：`Voucher(address consumer,address provider,uint256 cumulative,uint64 expires)`。
- `VOUCHER_TYPEHASH = keccak256("Voucher(address consumer,address provider,uint256 cumulative,uint64 expires)") = 0x8e017cc56e9f2cb1f0fd1af4419f7c77b8d3f92099263f2b8aba4ba44cf50407`。
- `structHash = keccak256(abi.encode(VOUCHER_TYPEHASH, consumer, provider, cumulative, expires))`；`digest = keccak256(0x1901 ‖ DOMAIN_SEPARATOR ‖ structHash)`。
- `provider` MUST 为服务容器（TAPI-20 §3.1）。`cumulative` 为消费者对该提供者应付的累计总额（以该托管实例所选代币 `token()` 的最小单位计，§3.5），对同一 `(consumer, provider)` 的各凭证 MUST 非递减。
- 签名者 MUST 为 `consumer` 本人，或由 `consumer` 通过 `authorizeSession(provider, key, expires)` **为这条 `(consumer, provider)` 通道**授权、且在结算时仍然有效的会话密钥：`sessionExpiry(consumer, provider, signer) ≥ block.timestamp`。会话无需覆盖凭证整个生命周期。没有撤销：密钥以那一条通道的余额与 `MAX_SESSION`（30 天）为界，自然过期（§8）。
- 凭证在 `block.timestamp ≤ expires`（含等于）期间有效；托管、提供者与 SDK 统一使用这一边界。

TAPI-21 请求中的线上形式：

```json
"voucher": { "consumer": "0x..", "provider": "0x..", "cumulative": "123", "expires": 1758400000, "sig": "0x..", "signer": "0x.." }
```

### 3.2 提供者校验

服务计费方法前，提供者 MUST 校验：

1. `sig` 恢复为 `signer`，且 `signer` 为 `consumer`，或满足 `sessionExpiry(consumer, provider, signer) ≥ block.timestamp` 的会话密钥——注意 `provider` 参数：为同一消费者另一条通道授权的密钥在此无效；
2. `now ≤ expires` —— 与 `settle` 相同的边界（§3.1）。提供者 SHOULD 额外要求足够的余量以便在 `expires` 前完成上链结算，并 MAY 对 `expires` 与签名会话的到期时间同时强制一个最短剩余寿命；这样做的提供者 MUST 在 `BAD_VOUCHER` 的 `data.minVoucherLifeS` 中报告该阈值（参考实现默认 300 秒，并在 `/tapeapi/v1/health` 中公布），且其结算频率 MUST 短于该值；
3. `cumulative > claimedOf(consumer, provider)` 且 `cumulative ≥ last + price`，其中 `last = max(lastCumulative[consumer][provider], claimedOf(consumer, provider))`。`lastCumulative` 是提供者自己的记录，MUST 与链上 `claimedOf` 对齐（重启或横向扩容后的提供者 MUST NOT 接受不高于 `claimedOf` 的凭证：它永远无法结算）；
4. 链上 `cumulative − claimedOf(consumer, provider) ≤ available`，其中当该通道上存在仍在生命周期内的提现请求（`now ≤ requestedAt + WITHDRAW_COOLDOWN + WITHDRAW_WINDOW`，§3.3.1）时 `available = channelOf(consumer, provider) − pendingWithdraw(consumer, provider).amount`，否则 `available = channelOf(consumer, provider)`。通道即上限；没有额度。这一扣减是 E-03 防御的提供者侧一半（§8）：冷静期内提供者仍可抢在请求前结算，但请求一旦可执行，所请求的金额就可以在结算所在区块离开，对其提供服务等于无担保赊账。自愿赊账的提供者（§3.3.1「部分结算」）MAY 对该消费者放宽此项检查。

提供者 MUST 仅在计费方法未附凭证被调用时返回 `PAYMENT_REQUIRED`，对任何已附带但不可接受的凭证（签名、过期、累计额过期或不足、超出通道）返回 `BAD_VOUCHER`。每个 `BAD_VOUCHER` 与每个 `PAYMENT_REQUIRED` MUST 携带 `data.price`：提供者对该方法收取的每次调用价格，以 BEM 最小单位（10⁻⁸ BEM；例如 `priceBEM: "0.0001"` 对应 `"10000"`）的十进制字符串表示，不带符号、小数部分或前导零。没有它，消费者无法区分价格过期与计数器过期，持有涨价前清单的消费者会永远按旧价重试（TAPI-20 §3.6）；消费者只把 `data.price` 当提示，付款前从链上重读清单。当拒绝原因是累计额过期时，错误的 `data` 还 MUST 携带 `lastCumulative`、`onChainClaimed`，以及（若提供者持有）消费者自己签发的对应凭证（`voucher: { cumulative, expires, sig }`）。客户端 MUST NOT 仅凭一个数字推进本地计数：MUST 先验证 `onChainClaimed` 不低于所报数额（任何人可自行读链核对），或所附凭证能恢复到消费者本人或其授权的会话密钥。采纳未经证明的数字，会让恶意提供者任报一个金额、诱使客户端为其签发凭证、再按通道余额足额结算——只需一个身份的成本，就能在一次调用里榨干消费者的这条通道。提供者 MUST 为每个 `(consumer, provider)` 保留最高的有效凭证以供结算，且 SHOULD 在 `min(expires, sessionExpiry(consumer, provider, signer))` 前结算（两个界限同时成立：凭证未过期，且会话仍然有效）。

### 3.3 托管接口

不可升级。`Ownable` 仅用于更换金库地址。"金库"角色包括已记账未领取的贡献（`treasuryAccrued`），而更换金库时先把它们付给旧金库（§3.4），所以 owner 无法改走一个能收款的金库已经挣得的钱；除此之外 owner 没有任何权力。所有余额、已结算额、会话与提现请求都以 `(consumer, provider)` 为键；同一消费者的两个提供者之间没有任何共享状态。

```
constructor(address token, address hub, address treasury)        // 均非零；treasury ≠ token、≠ 托管自身（BadTreasury）；token = 本实例唯一的 ERC-20（§3.5）；hub = DeWebHub，用于 accountOf
fund(address provider, uint256 amount)                           // transferFrom(msg.sender)；channel[msg.sender][provider] += amount；立即生效
requestWithdraw(address provider, uint256 amount)                // amount ≤ channel；记录 (amount, now)，覆盖旧请求
cancelWithdraw(address provider)                                 // 清除调用者在该通道上的待处理请求
withdraw(address provider)                                       // 在 [requestedAt + 48 h, requestedAt + 48 h + 7 d] 内；支付 min(所请求, 通道余额)
authorizeSession(address provider, address key, uint64 expires)  // 按通道；now < expires ≤ now + 30 d；只可延长；无撤销
setContribution(address circuits, uint256 tokenId, uint16 bps)   // 仅持有人；provider = hub.accountOf(circuits, tokenId)；0 ≤ bps ≤ 2000
settle(address consumer, address provider, uint256 cumulative, uint64 expires, bytes sig)
claimTreasury() → amount                                         // 任何人可调；把全部 treasuryAccrued 付给当前金库
setTreasury(address) / transferOwnership(address) / acceptOwnership()   // 仅 owner / 被提名者；除此之外没有任何 owner 权限；setTreasury 先付旧金库（§3.4）
channelOf(consumer, provider), claimedOf(consumer, provider), sessionExpiry(consumer, provider, key),
pendingWithdraw(consumer, provider) → (amount, requestedAt), contributionOf(provider), treasury, treasuryAccrued, hub, token,
DEFAULT_CONTRIBUTION_BPS (= 100), MAX_CONTRIBUTION_BPS (= 2000), WITHDRAW_COOLDOWN (= 48 h), WITHDRAW_WINDOW (= 7 d), MAX_SESSION (= 30 d),
DOMAIN_SEPARATOR, VOUCHER_TYPEHASH, voucherDigest   // 只读
events: Funded(consumer, provider, amount), WithdrawRequested(consumer, provider, amount, availableAt),
        WithdrawCancelled(consumer, provider), Withdrawn(consumer, provider, amount), SessionAuthorized(consumer, provider, key, expires),
        Settled(consumer, provider, paid, contribution, bps), ContributionSet(provider, bps), TreasuryChanged(old, new),
        TreasuryClaimed(treasury, amount), OwnershipTransferStarted(old, new), OwnershipTransferred(old, new)
errors: ZeroAddress, ZeroAmount, BadProvider, BadTreasury, InsufficientBalance, NoPendingWithdraw, CooldownActive(uint64 availableAt),
        WithdrawWindowClosed, AmountTooLarge, Expired, SessionTooLong(uint64 max), SessionShorteningNotSupported,
        BadSignature, NothingToSettle, NotHolder, ContributionTooHigh(uint16 bps), TransferFailed, Reentrancy,
        NotOwner, NotPendingOwner
```

`fund` 在 `amount == 0` 时 MUST 以 `ZeroAmount()` 回滚，在 `provider` 为零地址或托管自身时以 `BadProvider()` 回滚；MUST 先记入 `channelOf(msg.sender, provider)` 再划转代币，并发出 `Funded`。充给一个永不结算的提供者的通道，只能由消费者经 `requestWithdraw` / `withdraw` 取回。

`settle` MUST：任何人可调用；要求 `block.timestamp ≤ expires`（`Expired()`）；当 `provider` 为零地址或托管自身时以 `BadProvider()` 回滚；恢复签名者，仅当其为 `consumer` 或满足 `sessionExpiry(consumer, provider, signer) ≥ block.timestamp` 时接受（否则 `BadSignature()`）；要求 `cumulative > claimed[consumer][provider]`（`NothingToSettle()`）；计算 `delta = cumulative − claimed[consumer][provider]` 与 `paid = min(delta, channel[consumer][provider])`，并要求 `paid > 0`（`InsufficientBalance()`）；取本次结算时的 `bps = contributionOf(provider)`，计算 `contribution = paid × bps / 10000`；`claimed += paid`、`channel −= paid`；把 `contribution` 记入 `treasuryAccrued`；将 `paid − contribution` 转给 `provider`；发出 `Settled(consumer, provider, paid, contribution, bps)`。`settle` MUST NOT 把贡献额转给 `treasury`，因此收不了该代币的金库永远不会阻塞结算。`paid < delta` 即**部分结算**，是受支持的流程（§3.3.1）：`claimed` 按实付推进，同一张凭证在通道再次充值后 MAY 于 `expires` 前就剩余部分再次结算。

`claimTreasury()` MUST 任何人可调；收款人永远是当前 `treasury`，调用者只决定时机。`treasuryAccrued` 为 0 时它 MUST 以 `ZeroAmount()` 回滚；否则把 `treasuryAccrued` 置 0，把原值转给 `treasury`，发出 `TreasuryClaimed(treasury, amount)` 并返回该金额。转账失败时它 MUST 以 `TransferFailed()` 回滚且不改变任何状态；结算不受影响，应收额一直保留到能付出为止（§3.4，更换金库）。

托管发起的代币调用（`fund`、`withdraw`、`settle`、`claimTreasury`）只有在未回滚、且要么无返回值（被调地址有代码）、要么返回至少 32 字节且首字为 1 时才算成功；其它任何结果，包括 `false` 与 1 到 31 字节的返回，都使该调用以 `TransferFailed()` 回滚。

#### 3.3.1 消费者侧延迟（提供者保护）

只有一种消费者操作能缩小提供者可结算的金额，且它有延迟：

- **提现。** `requestWithdraw(provider, amount)` 要求 `amount > 0`（`ZeroAmount`）、`amount ≤ channelOf(msg.sender, provider)`（`InsufficientBalance`）且 `amount ≤ 2^192 − 1`（`AmountTooLarge`）；记录 `(amount, requestedAt = now)`，覆盖该通道上的旧请求并重新计时，并发出 `WithdrawRequested(consumer, provider, amount, availableAt = now + WITHDRAW_COOLDOWN)`。`withdraw(provider)` MUST 仅在 `requestedAt + WITHDRAW_COOLDOWN ≤ block.timestamp ≤ requestedAt + WITHDRAW_COOLDOWN + WITHDRAW_WINDOW` 期间成功；之前回滚 `CooldownActive(availableAt)`，之后回滚 `WithdrawWindowClosed()` 并需重新请求（重新计冷静期），因此请求无法提前数周上膛。它按**执行时**支付 `min(amount, channelOf)`——冷静期内的结算优先——清除请求并发出 `Withdrawn`；通道已被结算清空时回滚 `InsufficientBalance()` 且保留请求。被截断的请求整个被消耗；余下部分需重新请求。`cancelWithdraw(provider)` 可随时清除调用者的待处理请求（无请求时回滚 `NoPendingWithdraw()`），并发出 `WithdrawCancelled(consumer, provider)`；它只会减轻提供者的压力，故无延迟。
- **提供者的保护就是冷静期。** `WithdrawRequested` 是公开事件。提供者 MUST 对它服务的每一条通道监听该事件，并在 `availableAt` 前结算该通道上的全部应收（"前"是字面意思：恰好在 `availableAt` 那一秒，`settle` 与 `withdraw` 都会成功，谁先被打包谁拿钱，等到那一秒才动手的提供者已卷入一场可能输掉的竞争，两条边界由 `contracts/test/ClockBoundaries.t.sol` 钉住；提供者工具 SHOULD 在冷静期内尽早结算，运营方 SHOULD NOT 让提供者离线超过冷静期的一半）；不这样做的提供者，在消费者执行提现后拿不到它对该通道已提供服务的报酬。这与 v1 托管给出的保证在实质上完全相同：v1 中额度下调同样是公开事件（`AllowanceDecreaseRequested`），24 小时内未结算的提供者其凭证被截断为零。两种设计都归结为"一个公开事件 + 一个提供者 MUST 行动的固定窗口"；v2 只有一个这样的事件而非两个，窗口是 48 小时而非 24。请求存活期间，参考实现的提供者至多服务 `channelOf − pendingWithdraw.amount`（§3.2(4)）；监听 `WithdrawRequested` 并在 `availableAt` 之前结算是运营方的职责（运行时提供 `pendingSettlements()`（截止时间为 `min(expires, sessionExpiry)`）、`dueSettlements()`（列出此刻必须结算的凭证：截止时间在余量之内，或通道挂着提现请求）与 `settleTx()`；运行时不持有钱包，`examples/_lib/sendtx.mjs` 提供签名并发送这些交易的结算循环）。 48 h 的保证以*请求*为单位，而非以通道为单位：`fund` 不会重置它，因此在请求存活期间充入的额度，会在该请求可执行的那一刻起、在已宣告的数额内立即可提。所以只在 `availableAt` 之前结算并不足够；提供者还 MUST 拒绝在存活请求之上超出 `channelOf − pendingWithdraw.amount` 的服务（§3.2(4)），这一减法是承重的，不是建议。
- **充值**只增不减、立即生效。**会话**（`authorizeSession(provider, key, expires)`）要求 `key ≠ 0`、`provider` 非零且非托管自身、`now < expires ≤ now + MAX_SESSION`（`Expired` / `SessionTooLong(max)`），且只可延长：低于当前到期时间回滚 `SessionShorteningNotSupported()`。没有撤销。想要更紧边界的消费者应授权更短的密钥或充更小的通道；两者提供者在服务前都能在链上看到。
- **部分结算是赊账流程，不是防御。** 继续服务超过 `channelOf − claimedOf` 的提供者是在自愿赊账；托管支付通道现有的部分，其余在消费者再充值后支付。不愿赊账的提供者执行 §3.2(4)，在通道用尽时停止服务。
- **所有权。** 两步转移：`transferOwnership(newOwner)` 仅提名（`OwnershipTransferStarted`）；被提名者调用 `acceptOwnership()` 完成（`OwnershipTransferred`）。

偿付关系（参考实现的不变量套件持续校验）：`token.balanceOf(escrow) ≥ Σ channelOf(c, p) + treasuryAccrued`，`Σ channelOf + Σ paid == Σ funded − Σ withdrawn`，且 `Σ Settled.contribution == treasuryAccrued + Σ TreasuryClaimed.amount`。关系是 `≥` 而不是 `==`：任何人都可以把代币直接转给托管，这样的捐赠留在原处（没有清扫），托管里没有任何东西依赖等式。

### 3.4 维护贡献（无强制费用）

- **没有运营方费用。** 托管 MUST NOT 收取属于它自己的费用，MUST NOT 暴露任何运营方可设的费率、暂停开关或对用户余额的访问。合约中唯一的比例是提供者的贡献比例，且只有提供者自己能控制。
- **默认 100 bps，由提供者设定。** 在提供者设定之前，`contributionOf(provider)` MUST 返回 `DEFAULT_CONTRIBUTION_BPS = 100`（1%）。默认值是合约常量，不是参数：部署后任何人都改不了它。贡献比例 MAY 仅由服务电路的当前持有人通过 `setContribution(circuits, tokenId, bps)` 修改，其中 `provider = hub.accountOf(circuits, tokenId)`；接受 0（不贡献）到 `MAX_CONTRIBUTION_BPS = 2000`（20%，同样是常量）之间的任意值，一旦设定，该值（包括 0）即取代默认值。托管 MUST 在存储中区分"从未设定"与"设为 0"，使设为 0 的提供者读到 0、不贡献任何金额，而绝不会读到默认值。托管 MUST 强制 `bps ≤ MAX_CONTRIBUTION_BPS`，且 MUST 发出 `ContributionSet(provider, bps)`。电路转让后该权利随之转移给新持有人。
- **用途，以及设为 0 不受任何惩罚。** 贡献用于标准维护：规范维护、参考实现、审计、目录站运营。设为 0 bps 的提供者 MUST 得到托管、SDK 与其他提供者完全相同的对待；目录站 MAY 展示该值，但 MUST NOT 据此给服务排序、排位或打任何标记，也 MUST NOT 据此限制功能。
- **从提供者份额中划出。** 贡献在结算时从提供者本应收到的金额中扣除；消费者的价格不变。`bps` 的修改只作用于修改之后的结算，绝不追溯：此前已结算的金额不重算，尚未结算的凭证按结算时有效的比例拆分。贡献向下取整；取整为 0 时不记入任何应收。
- **金库。** `treasury` 在构造函数中设定，MUST 在 Final 前发布于 §6（及仓库 README）。它 MAY 仅由 owner 通过 `setTreasury` 修改，该函数 MUST 发出 `TreasuryChanged(old, new)`，MUST 拒绝零地址（`ZeroAddress()`），并 MUST 拒绝托管自身与其代币（`BadTreasury()`；构造函数同样拒绝），因为领到这两处的应收额会永久卡死。"金库"角色包括已记账未领取的应收额。有应收时，`setTreasury` MUST 先为旧金库尝试一次 `claimTreasury()`，使更换无法改走该金库已经挣得的钱；这次尝试失败时它被完整回滚，而更换 MUST 照样成功，应收额留给新金库。收不了该代币的金库（被冻结，或拒收的合约）就是这样被无损替换的，它永远挡不住自己被替换。换成当前金库什么也不改变、也不发事件。除更换金库外 owner MUST 没有任何其它权力：没有费率开关、不能暂停、不能动通道或用户余额、不能修改任何 provider 的 `bps` 或默认值，也无法把应收额付给 `treasury` 以外的任何人。
- **替代部署。** 任何实现 §3.1–§3.3 的托管即为合规；它 MAY 省略 `setContribution` / `contributionOf`，此时客户端 MUST 将贡献视为 0。服务通过 `manifest.payment.escrow` 选择其托管；客户端 MUST 使用该地址，MUST NOT 假定存在规范部署。若社区将来希望有统一协议费，正确路径是新的 TAP 与新的托管部署，而不是修改现有合约。

**送审的那一版（说明性内容）。** 将送审并部署的托管在 BNB Smart Chain 上每个实例只托管一种 ERC-20，首个是 USDT 锚定币，BEM、WBNB 与（经 WBNB 的）BNB 按需（§3.5）。§3.1–§3.4 适用于每个实例，金额以该实例代币的最小单位计。按实际用量结算的 `upto` 本版未实现、未规定，也不在送审范围内。在托管部署之前，任何调用都不收取任何费用。

### 3.5 托管资产（说明性）

实验性，未部署，未经审计。本小节记录送审的那一版托管计划托管哪种代币、一种代币如何被准入，以及这对合约与 SDK 意味着什么。它不规定任何接口：§3.1–§3.4 适用于每个实例。依据是 2026-10-04 对三家独立 RPC 运营方做的两轮只读链上评估，第二轮复核第一轮。

**托管什么（2026-10-05 的决定）。** 首个支持的实例托管 BNB Smart Chain 上的 USDT 锚定币：Binance-Peg "BSC-USD"，`0x55d398326f99059fF775485246999027B3197955`。它由 Binance 而非 Tether 发行，其 `name()` 写着 "Tether USD"，所以 SDK 与控制台 SHOULD 把它显示为 "USDT (Binance-Peg)" 并附上地址。BEM、WBNB 与 BNB（经 WBNB）按需，用同一份字节码，每种代币一个实例，代币是不可变的构造参数；它们不是首次部署的一部分。没有任何合约持有可由 owner 编辑的代币表。

**准入标准。** 一种代币只有在下面每一项都成立时才有资格拥有实例。每一项都能在链上或对照已验证的源码核查，结果按实例记录。

1. 不可升级：不是代理（EIP-1967、EIP-1822 与 beacon 槽均为空），没有 `upgradeTo*`，运行时代码里没有 `DELEGATECALL` 或 `SELFDESTRUCT`。代理无论由谁持有管理员钥匙都不合格；管理员是单个外部账户是最极端的情形。
2. 没有冻结、暂停或拉黑某个地址、或销毁他人余额的函数，或这些函数任何人都不可达（扫描分发选择器，并模拟 owner 或管理员账户的调用）。
3. 标准 ERC-20 转账：转账不扣费、不变基、余额只有一个入口、没有收款方钩子；`transfer` 与 `transferFrom` 返回 `true` 或不返回；向合约地址转账成功（至少在两家运营方上模拟，包括 `approve` + `transferFrom`）。
4. `decimals` 固定，由代币合约自己的 `decimals()` 读取，且 8 ≤ `decimals` ≤ 18。
5. 源码已验证且与已部署字节码一致，并公开一张表，写明谁能增发、升级、暂停或冻结（外部账户、多签或合约，及阈值），读数在至少两家运营方之间一致。

增发权与发行方背书是价值风险，不是锁死风险：它们按实例披露，不决定准入。第 1、2 项不放宽。原因在于托管的形状：一个实例就是一个地址，持有该代币的全部通道，且按设计没有救援路径。该地址被冻结，会让每条通道的 `fund`、`settle` 与 `withdraw` 同时停止。暂停更糟：`requestWithdraw` 不碰代币，所以提现冷静期可能在每个提供者的 `settle` 都回滚的时候走完，暂停结束时，消费者的 `withdraw` 与提供者的 `settle` 会抢同一笔钱。因此可暂停的代币被排除，而不是在合约里处理。

**USDT 锚定币为什么合格（2026-10-04 评估）。**

- 第 1 项：运行时代码 4,413 字节；所有代理槽均为零；没有 `DELEGATECALL`、`SELFDESTRUCT` 或 `CALL` 操作码（因此没有收款方钩子）；三家运营方读到的代码哈希相同。
- 第 2 项：字节码里全部 30 个 `PUSH4` 常量都已认领：20 个分发选择器（ERC-20 及 `increaseAllowance`、`decreaseAllowance`，`mint(uint256)`、`burn(uint256)`，`owner`、`getOwner`、`renounceOwnership`、`transferOwnership`，以及公开的 `_name`、`_symbol`、`_decimals` getter）与 10 个不是选择器的常量（编译器元数据标记、一个掩码、revert 字符串片段、一个 24 字节常量内部的字节）。没有一个是冻结、暂停、拉黑、救援或升级函数。owner 是单个外部账户（`0xF68a4b64162906efF0fF6aE34E2bB1Cd42FEf62d`），只能给自己增发、销毁自己的代币，别无其它：模拟 owner 调 `mint` 只增加 owner 自己的余额，其他任何人调用都回滚，也没有 `burnFrom` 与 `mint(address,uint256)`。
- 第 3 项：从流动性池向合约地址与外部账户模拟 `transfer` 与 `approve` + `transferFrom`，都返回 `true`，双方余额的变化恰好等于金额；两个账户之间的第二跳同样精确。
- 第 4 项：`decimals()` 为 18，不是以太坊上同名代币的 6。
- 第 5 项，仍未完成：区块浏览器上的源码验证与持有人集中度尚未核查，二者都是任何部署之前必须完成的。

剩下的是价值风险：对发行方链下持有的储备的债权，以及一把可以无限增发的钥匙，所以代币可能脱锚而托管照常运转。敞口是不对称的：脱锚时提供者可以随时结算，而消费者必须先 `requestWithdraw` 再等 48 小时冷静期，这是通道宜小额的又一个理由（§8）。

**不予准入。**

| 代币 | 不予准入的原因（不满足的项） |
|---|---|
| BNB Chain 上的 USDC（Binance-Peg），`0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d` | 透明代理，管理员是单个外部账户；`upgradeTo` 立即生效、没有时间锁，任何审计在被使用的那一刻就失效（1） |
| BNB Chain 上的 USD1，`0x8d0D000Ee44948FC98c9B98A4FA4921476f08B0d` | 可升级（多签管理员）；`freeze` 阻止转入与转出被冻结的地址，包括向它的 `transferFrom`，`pause` 则停止全部转账；两者都没有时间锁（1、2） |
| BNB Chain 上的 FDUSD，`0xc5f0f7b66764F6ec8C8Dff7BA683102295E16409` | 同 USD1（1、2） |
| X Layer 上的 USD₮0 | 6 位小数；可升级代理；有黑名单，被列入者的余额可被销毁（1、2、4） |

另外不在计划内的：Binance-Peg 的 BUSD、ETH 与 DAI（没有托管用途），以及 lisUSD（升级时间锁为一天，短于 48 小时冷静期）。发行方原生的 USDC 与 USDT，凡在某条链上存在的，按设计带有发行方黑名单，都过不了第 2 项。

**价格与金额。** 默认计价单位是 USDT。托管金额（`fund`、`channelOf`、凭证的 `cumulative`、提现）一律用代币自己的最小单位，以其 `decimals()` 定义：USDT 锚定币是 18 位，所以 10 USDT 是 `10000000000000000000`。SDK 与文档 SHOULD 从代币读取 `decimals()`，SHOULD NOT 把 BEM 的 8 位小数硬编码进托管金额；8 位小数的约定只属于 `priceBEM`，它为兼容起见保持不变。永远不在代币之间换算：一个实例只记自己的代币。多币种价格（以代币地址为键的 `prices` 映射）、清单如何列出多个托管，以及 BEM 以外的代币的 `data.price` 的形式，目前尚未规定。

**客户端行为（实验性）。** SDK SHOULD 默认只为已审计部署名单内的托管构造 `approve` 与 `fund` 交易（名单随 SDK 发布，或由调用方提供），对名单以外的托管 SHOULD 要求明确选择启用。`approve` 把拉取代币的权利交给托管，而恶意清单可以指向一个报出真实代币地址的合约，其 `fund` 却会拿走全部已授权的额度。托管尚未部署，所以这份名单今天是空的。服务所指定的 `payment.escrow` 地址仍决定凭证为哪个托管而签（§3.4）。

**送审那一版的计划内容**（仓库中合约的现状；该合约既未审计也未部署）：

- 已完成：构造参数是不可变的 `token`（§3.3）；每种代币一个实例，同一份字节码。合约从不读取 `decimals()`。
- 已完成：偿付写成 `token.balanceOf(escrow) ≥ Σ channelOf(c, p) + treasuryAccrued`，而不是 `==`（§3.3）：任何人都可以把代币直接转给托管，这样的捐赠留在原处（按设计没有清扫）。不变量套件有直接转入的用例。
- 已完成并已规定（§3.3、§3.4）：贡献记入金库应收额（`treasuryAccrued`），由任何人可发起的单独调用付给当前金库（`claimTreasury()`，事件 `TreasuryClaimed`），而不是在 `settle` 内转出，这样无法接收该代币的金库永远不会阻塞提供者的结算。更换金库时先付旧金库，只有这笔付款失败时应收额才留给新金库。
- 没有暂停，也无需处理：可暂停的代币不予准入（见上）。
- 已决定：凭证不写明代币。`verifyingContract` 已把凭证钉在一个托管上，而托管的代币不可变，所以凭证无法被重放到另一种代币；用错小数位计算 `cumulative` 的客户端也不会因多一个字段而受益。参考 SDK 改为在构造 `approve` 或 `fund`、或签发凭证之前读取托管的 `token()` 与 `decimals()`，并拒绝代币不是它所预期的那个的托管（尚未实现；任何部署之前必须完成）。

**原生 BNB 不是托管资产。** 托管只持有 ERC-20，BNB 以 WBNB 持有，由付款方在 `approve` 与 `fund` 之前自己包装（`WBNB.deposit`）；合约永不拆包。2026-10-04 的两项测试（状态覆盖与 `eth_estimateGas`）说明了原因。服务容器只有在发送方提供足够 gas 时才能收下原生 BNB（一笔普通转账总共需要约 32,000 gas，2,300 gas 的推送会失败）。WBNB 的 `withdraw` 恰好用 2,300 gas 推送原生 BNB，所以容器自己无法拆 WBNB：调用回滚，而同一调用从普通地址发出则成功。容器收到的 WBNB 必须转到持有人钱包再在那里拆包。原生 BNB 仍可在 gas 足够时直接充值到容器；它是充值路径，不是托管资产。


## 4. 原理

累计凭证无需 nonce 且容忍消息丢失：最新一张取代之前所有。结算到容器意味着收入随电路转让而转移。每个 `(consumer, provider)` 一条通道使"上限"与"资金"成为同一样东西：没有可下调的额度，没有可供两个提供者竞争的共享余额，也没有第二条出口让消费者把诚实提供者已挣到的钱付给自己——v1 的 Critical（部署前审计的 C-01）不是被防住，而是无法表达。由此额度下调延迟、承诺记账、懒同步、额度上限、撤销延迟与结算截断全部消失，只剩一个延迟——提现冷静期——其保证与 v1 的两个延迟给出的相同（§3.3.1）。会话密钥使消费者主密钥远离浏览器；将其限定于一条通道，意味着泄露的密钥以该通道与 `MAX_SESSION` 为界，这正是不需要撤销的原因。部分结算成为诚实的功能：提供者可以对信任的消费者赊账，并在通道再充值后收款。

## 5. 向后兼容

不向 `SPEC.md` 添加任何内容；不改变名称语法或 §15.1 不变量。不带凭证的 TAPI-21 信封对免费方法仍然有效。凭证类型、域与 `VOUCHER_TYPEHASH` 与 v1 相同，签名代码未变；托管 ABI 变了（`fund` / `requestWithdraw(provider, …)` / `withdraw(provider)` / `authorizeSession(provider, key, expires)` / `channelOf` / 三参数 `sessionExpiry` / 双参数 `pendingWithdraw`），而 v1 托管从未部署。§3.4 的默认值于 2026-09-28 从 0 改为 100 bps，当时没有部署任何托管，也没有任何调用付过费。

## 6. 测试向量

| 项目 | 值 |
|---|---|
| `VOUCHER_TYPEHASH` | `0x8e017cc56e9f2cb1f0fd1af4419f7c77b8d3f92099263f2b8aba4ba44cf50407` |
| `keccak256("TapeAPIEscrow")` | `0x9e119fcf121b28516e9297f2c41bbb6b5899ca62f3f2122145a86c0b2ddf863a` |
| 参考托管地址 / `treasury` | TODO（未部署） |
| 凭证摘要算例 | `spec/vectors/tapi-22-voucher.json`，由 `spec/vectors/verify.py` 与 Solidity 测试套件独立校验 |

## 7. 参考实现

`contracts/src/TapeAPIEscrow.sol`（v1 归档于 `contracts/archive/TapeAPIEscrow.v1.sol`）；回归套件 `contracts/test/Attacks.t.sol`（v1 审计中的每个攻击对 v2 重放）与 `contracts/test/EscrowInvariant.t.sol`（偿付恒等式、`claimed` 单调、不超付、通道内凭证在冷静期内足额兑付）。SDK `api.payer`（接受 `sessionExpiry` 仅用于在会话已失效时拒绝签发；`voucher.expires` 只受 `ttl` 约束）、`api.tx.fund / requestWithdraw / cancelWithdraw / withdraw / authorizeSession(provider, key, expires) / settle / setContribution`、`api.chain.escrow.channelOf / claimedOf / sessionExpiry / pendingWithdraw`，以及 `api.resolve` 返回的 `svc.contribution`；服务端凭证校验按 §3.2 读取 `channelOf`、`claimedOf` 与 `pendingWithdraw(consumer, provider)`，`pendingSettlements` / `settleTx` 与 `provider.contribution()`（不在 `/tapeapi/v1/health` 中公开）。尚未部署：见本译文开头的实现状态。自 2026-10-05 起，v3 合约按本文 §3.4 实现：`DEFAULT_CONTRIBUTION_BPS = 100`、`MAX_CONTRIBUTION_BPS = 2000`、区分"从未设定"与"设为 0"，并在 `Settled` 中给出所用的 `bps`。它仍未经审计；送审并部署的那一版托管在此基础上加入 §3.4 末尾与 §3.5 所列的计划内容，只有那一版会送审并部署。仓库中的合约已经具备 §3.5 标为已完成或已实现的各项，包括拉取式金库（§3.3、§3.4）。

## 8. 安全考量

- **提供者的保护是 48 小时冷静期。** 它 MUST 对所服务的每条通道监听 `WithdrawRequested` 并在冷静期内结算；不这样做的提供者，在提现执行后拿不到它对该通道已提供服务的报酬。这与 v1 的保证在实质上完全相同：v1 中公开事件是额度下调请求、窗口是 24 小时。这一取舍是有意的：一个公开事件、一个窗口，而非两个。提供者 SHOULD 在未结算 delta 超过阈值时结算，MUST 在 `min(expires, sessionExpiry(consumer, provider, signer))` 前结算，且 SHOULD 对其通道上存在生命周期内提现请求的消费者停止服务（§3.2(4)）。
- **结算抢跑。** `requestWithdraw` 是唯一能缩小通道的消费者操作，且 48 小时内无效；`fund` 只增、`authorizeSession` 只延长、没有撤销。因此在 `WithdrawRequested` 后及时提交的结算总会成功。未在 7 天窗口内执行的提现请求自动失效。
- **通道就是双向的全部敞口。** 消费者对某提供者的敞口恰为 `channelOf(consumer, provider)`；恶意提供者无法索取更多，也碰不到同一消费者的任何其它通道。消费者 SHOULD 适量充值并勤补充，而非把大额资金停放在一个提供者处。
- **泄露的会话密钥以一条通道与 `MAX_SESSION` 为界。** 密钥按 `(consumer, provider)` 授权，且不能授权到 30 天以后；它能签的金额以该通道余额为限，并自然过期。没有撤销；想要更紧边界的消费者 SHOULD 使用短期密钥与小额通道。没有任何东西把凭证绑定到签发时刻（部署前审计第二轮 N-03）：重新授权一把曾签过未结算凭证的密钥会使那些凭证复活，边界是该通道上的 `cumulative − claimedOf`。消费者 SHOULD 每段合作换一把新密钥，而不是重新授权旧密钥。
- **部分结算是受支持的赊账流程。** `settle` 支付 `min(cumulative − claimedOf, channelOf)`，同一张凭证在补充后续结余额。服务超过通道的提供者是在自愿赊账；托管既不阻止也不担保。
- **自我交易无害。** 消费者 MAY 给自己开通道并结算回来；那只搬动了自己的钱，碰不到任何其它通道。没有共享池可供第二条出口榨干。
- 边界：凭证在 `block.timestamp ≤ expires` 期间有效；托管、提供者与 SDK 三方均使用这一含等号的边界。
- `chainId` 与 `verifyingContract` 防止跨链与跨托管重放。一个托管的凭证在另一个托管中无意义。
- 贡献只能减少提供者自己的收款且上限 20%；它永远不能增加消费者的支出或移动消费者通道。1% 的默认值是部署时固定的常量，之后谁都不能调高。更换金库是 owner 的唯一权力，且总是通过 `TreasuryChanged` 在链上可见；它无法从一个能收该代币的金库手中拿走未领取的应收额，因为更换时先付旧金库。
- 重写已通过全部既往攻击的回归套件，但 MUST 再经一轮独立对抗审计才算可部署，且仅在有真实付费需求时部署。

## 9. 版权

Copyright and related rights waived via CC0-1.0.
