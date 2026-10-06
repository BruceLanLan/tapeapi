// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Escrow vs the hostile-token family in test/mocks/MaliciousTokens.sol (RESEARCH-process-security.md 6.1 P0-3).
// Two classes, kept apart on purpose (docs/AUDIT-escrow-v3.md §5):
//
// BLOCKED BY THE CONTRACT (must hold for any token, admitted or not):
//   re-entrancy      fund / settle / withdraw / claimTreasury are nonReentrant; re-entering any of them from a token
//                    callback (the token itself, or a recipient hook) reverts with exactly `Reentrancy()`; the
//                    unguarded requestWithdraw / cancelWithdraw / authorizeSession are reachable but move no funds.
//   false return     `_callToken` treats `false` as failure: the whole call reverts `TransferFailed()`, atomically.
//   no return value  accepted (USDT-style), provided the token address has code; a codeless "token" is refused.
//   treasury cannot  (v3 pull) a frozen / blocklisted / rejecting treasury never blocks `settle`: only
//   receive          `claimTreasury` fails, atomically; `setTreasury` still rotates (its payout to the outgoing
//                    treasury fails without reverting) and the accrual is claimable to the new treasury.
//
// EXCLUDED BY ADMISSION (TAPI-22 §3.5; the contract does not defend, the tests pin HOW it breaks):
//   fee-on-transfer  the solvency identity breaks by exactly the fee at `fund`; the last withdrawer is left short.
//   negative rebase  same shape: the escrow holds less than it owes; the last exit reverts.
//   positive rebase  harmless surplus, like a direct donation (stays, no sweep); still excluded (item 3).
//   freeze of escrow every path stops until unfrozen (no loss of accounting) -- item 2.
//   pause            requestWithdraw does not touch the token, so the cooldown runs out while settle reverts; at
//                    unpause withdraw and settle race for the same funds -- item 2, the reason pausable is excluded.
// 两类分开：合约必须挡住的（重入、返回 false、无返回值、无代码、金库收不了款）与准入标准直接排除、合约不防御的
// （转账收费、负变基、正变基、冻结托管、暂停）。后者的测试只钉住它"怎样坏"。

import "forge-std/Test.sol";
import {TapeAPIEscrow} from "../src/TapeAPIEscrow.sol";
import {Reentrancy, TransferFailed, NothingToSettle, CooldownActive, InsufficientBalance, ZeroAmount} from "../src/interfaces.sol";
import {
    Mal_ERC20, Mal_ERC721, Mal_Hub, Mal_ReentrantToken, Mal_FalseToken, Mal_NoReturnToken, Mal_FeeOnTransferToken,
    Mal_BlocklistToken, Mal_RebaseToken, Mal_RecipientHookToken, Mal_HostileTreasury
} from "./mocks/MaliciousTokens.sol";

/// @dev A hub that derives one chosen provider address for every circuit, so a test can pick the provider's bytes
///      (here: low byte 0x01, the same byte a stale scratch word would need to read as `true`).
///      对任何容器都推导出同一个指定提供者地址的 hub，让测试自选提供者地址的字节（此处低字节 0x01）。
contract Scratch_FixedHub {
    address public immutable provider;
    constructor(address provider_) { provider = provider_; }
    function accountOf(address, uint256) external view returns (address) { return provider; }
}

/// @dev Answers every call with exactly 31 zero bytes and moves nothing (etched over a funded token).
///      对任何调用只返回 31 个零字节、不动任何余额（etch 到已充值的代币上）。
contract Scratch_ShortZeroReturn {
    fallback() external {
        assembly { mstore(0x00, 0) return(0x00, 31) }
    }
}

/// @dev Reverts every call, with `revertWord` as its revert data (`word 1` = the bytes of a canonical `true`) or
///      with nothing at all. Deployed with the data, then its code is etched over a funded token.
///      对任何调用回滚，回滚数据是一个字（1 即规范 `true` 的字节）或空。
contract Scratch_RevertsWithOne {
    fallback() external {
        assembly { mstore(0x00, 1) revert(0x00, 32) }
    }
}

contract Scratch_RevertsWithNothing {
    fallback() external {
        assembly { revert(0x00, 0x00) }
    }
}

contract MaliciousTokensTest is Test {
    Mal_ERC721 nft;
    Mal_Hub hub;
    address treasury = address(0x7EA5);
    address holder = address(0xA11CE);
    uint256 constant CONSUMER_PK = 0xC0FFEE;
    uint256 constant CONSUMER2_PK = 0xC0FFEE2;
    address consumer;
    address consumer2;
    address provider;
    uint256 constant TOKEN = 7;
    uint256 constant UNIT = 1e8;
    uint256 constant CHANNEL = 1_000 * UNIT;

    function setUp() public {
        vm.warp(1_758_300_000);
        consumer = vm.addr(CONSUMER_PK);
        consumer2 = vm.addr(CONSUMER2_PK);
        nft = new Mal_ERC721();
        hub = new Mal_Hub();
        nft.mint(holder, TOKEN);
        provider = hub.accountOf(address(nft), TOKEN);
    }

    function _sig(TapeAPIEscrow e, uint256 pk, address c, uint256 cum, uint64 exp) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, e.voucherDigest(c, provider, cum, exp));
        return abi.encodePacked(r, s, v);
    }

    // ---------------------------------------------------------------------------------------------
    // Re-entrancy / 重入
    // ---------------------------------------------------------------------------------------------

    function _reentrantSetup() internal returns (Mal_ReentrantToken tok, TapeAPIEscrow esc) {
        tok = new Mal_ReentrantToken();
        esc = new TapeAPIEscrow(address(tok), address(hub), treasury);
        tok.setEscrow(esc);
        tok.openOwnChannel(provider, CHANNEL);           // token is itself a funded consumer with an armed request
        tok.mint(consumer, 10 * CHANNEL);
        vm.prank(consumer); tok.approve(address(esc), type(uint256).max);
        vm.prank(holder); esc.setContribution(address(nft), TOKEN, 250);   // non-zero accrual on every settle / 每次结算都有应收额
    }

    function _assertSolvent(Mal_ERC20 tok, TapeAPIEscrow esc) internal view {
        assertEq(
            tok.balanceOf(address(esc)),
            esc.channelOf(consumer, provider) + esc.channelOf(address(tok), provider) + esc.treasuryAccrued(),
            "escrow balance == sum of channels + treasury accrual"
        );
    }

    function _assertReentrancy(Mal_ReentrantToken tok) internal view {
        assertEq(tok.fired(), 1, "hook fired");
        assertFalse(tok.lastOk(), "re-entrant call must fail");
        assertEq(bytes4(tok.lastErr()), Reentrancy.selector, "guard fires before any other check");
    }

    /// fund's transferFrom re-enters settle / withdraw / fund: each reverts Reentrancy; fund completes exactly once.
    function test_reentrantToken_fromFund_guardedEntriesBlocked() public {
        Mal_ReentrantToken.Target[3] memory ts =
            [Mal_ReentrantToken.Target.Settle, Mal_ReentrantToken.Target.Withdraw, Mal_ReentrantToken.Target.Fund];
        (Mal_ReentrantToken tok, TapeAPIEscrow esc) = _reentrantSetup();
        vm.warp(block.timestamp + 48 hours);             // token's own withdraw would be executable without the guard
        uint64 exp = uint64(block.timestamp + 1 hours);
        for (uint256 i = 0; i < 3; i++) {
            // a valid voucher on consumer's channel, so a missing guard would pay it / 有效凭证：若无锁会被兑付
            vm.prank(consumer); esc.fund(provider, 1);
            tok.setVoucher(consumer, provider, 1, exp, _sig(esc, CONSUMER_PK, consumer, 1, exp));
            uint256 chTok = esc.channelOf(address(tok), provider);
            tok.arm(ts[i], false, true, false);
            vm.prank(consumer); esc.fund(provider, 100 * UNIT);
            _assertReentrancy(tok);
            assertEq(esc.claimedOf(consumer, provider), 0, "no settle happened inside fund");
            assertEq(esc.channelOf(address(tok), provider), chTok, "token channel untouched");
            _assertSolvent(tok, esc);
            // drain the 1-unit channel's voucher state for the next round is unnecessary: claimed stays 0
        }
        assertEq(esc.channelOf(consumer, provider), 3 * (100 * UNIT + 1));
    }

    /// settle's payout re-enters settle with THE SAME voucher (double-pay attempt), withdraw, fund: all Reentrancy.
    function test_reentrantToken_fromSettle_doubleSettleBlocked() public {
        Mal_ReentrantToken.Target[3] memory ts =
            [Mal_ReentrantToken.Target.Settle, Mal_ReentrantToken.Target.Withdraw, Mal_ReentrantToken.Target.Fund];
        (Mal_ReentrantToken tok, TapeAPIEscrow esc) = _reentrantSetup();
        vm.prank(consumer); esc.fund(provider, CHANNEL);
        vm.warp(block.timestamp + 48 hours);
        uint64 exp = uint64(block.timestamp + 1 hours);
        for (uint256 i = 0; i < 3; i++) {
            uint256 cum = (i + 1) * 100 * UNIT;
            bytes memory sig = _sig(esc, CONSUMER_PK, consumer, cum, exp);
            tok.setVoucher(consumer, provider, cum, exp, sig);
            uint256 pBefore = tok.balanceOf(provider);
            uint256 aBefore = esc.treasuryAccrued();
            tok.arm(ts[i], true, false, false);
            esc.settle(consumer, provider, cum, exp, sig);
            _assertReentrancy(tok);
            uint256 contribution = 100 * UNIT * 250 / 10_000;
            assertEq(tok.balanceOf(provider) - pBefore, 100 * UNIT - contribution, "provider paid once");
            assertEq(esc.treasuryAccrued() - aBefore, contribution, "treasury accrued once");
            assertEq(tok.balanceOf(treasury), 0, "settle pushes nothing to the treasury (v3 pull)");
            assertEq(esc.claimedOf(consumer, provider), cum);
            _assertSolvent(tok, esc);
        }
        // and the voucher is spent / 凭证已用尽
        bytes memory spent = _sig(esc, CONSUMER_PK, consumer, 300 * UNIT, exp);
        vm.expectRevert(NothingToSettle.selector);
        esc.settle(consumer, provider, 300 * UNIT, exp, spent);
    }

    /// withdraw's payout re-enters withdraw / settle / fund: all Reentrancy; the consumer is paid exactly once.
    function test_reentrantToken_fromWithdraw_doubleWithdrawBlocked() public {
        Mal_ReentrantToken.Target[3] memory ts =
            [Mal_ReentrantToken.Target.Withdraw, Mal_ReentrantToken.Target.Settle, Mal_ReentrantToken.Target.Fund];
        (Mal_ReentrantToken tok, TapeAPIEscrow esc) = _reentrantSetup();
        vm.prank(consumer); esc.fund(provider, CHANNEL);
        uint64 exp = uint64(block.timestamp + 30 days);
        tok.setVoucher(consumer, provider, 1, exp, _sig(esc, CONSUMER_PK, consumer, 1, exp));
        for (uint256 i = 0; i < 3; i++) {
            vm.prank(consumer); esc.requestWithdraw(provider, 100 * UNIT);
            vm.warp(block.timestamp + 48 hours);
            uint256 before = tok.balanceOf(consumer);
            uint256 chTok = esc.channelOf(address(tok), provider);
            tok.arm(ts[i], true, false, false);
            vm.prank(consumer); esc.withdraw(provider);
            _assertReentrancy(tok);
            assertEq(tok.balanceOf(consumer) - before, 100 * UNIT, "withdrawn once");
            assertEq(esc.channelOf(address(tok), provider), chTok, "token's own armed withdraw did not run");
            assertEq(esc.claimedOf(consumer, provider), 0, "no settle inside withdraw");
            _assertSolvent(tok, esc);
        }
    }

    /// If the token lets the re-entrant revert bubble, its transfer fails and `_callToken` turns that into
    /// TransferFailed: the outer call reverts atomically, nothing changes.
    function test_reentrantToken_bubblingRevert_outerRevertsAtomically() public {
        (Mal_ReentrantToken tok, TapeAPIEscrow esc) = _reentrantSetup();
        vm.prank(consumer); esc.fund(provider, CHANNEL);
        uint64 exp = uint64(block.timestamp + 1 hours);
        bytes memory sig = _sig(esc, CONSUMER_PK, consumer, 10 * UNIT, exp);
        tok.setVoucher(consumer, provider, 10 * UNIT, exp, sig);

        tok.arm(Mal_ReentrantToken.Target.Settle, true, false, true);
        vm.expectRevert(TransferFailed.selector);
        esc.settle(consumer, provider, 10 * UNIT, exp, sig);
        assertEq(esc.claimedOf(consumer, provider), 0);
        assertEq(esc.channelOf(consumer, provider), CHANNEL);

        tok.arm(Mal_ReentrantToken.Target.Fund, false, true, true);
        vm.prank(consumer);
        vm.expectRevert(TransferFailed.selector);
        esc.fund(provider, 5 * UNIT);
        assertEq(esc.channelOf(consumer, provider), CHANNEL);

        vm.prank(consumer); esc.requestWithdraw(provider, 7 * UNIT);
        vm.warp(block.timestamp + 48 hours);
        tok.arm(Mal_ReentrantToken.Target.Withdraw, true, false, true);
        vm.prank(consumer);
        vm.expectRevert(TransferFailed.selector);
        esc.withdraw(provider);
        (uint256 amt,) = esc.pendingWithdraw(consumer, provider);
        assertEq(amt, 7 * UNIT, "request survives the reverted withdraw");
        assertEq(esc.channelOf(consumer, provider), CHANNEL);
        _assertSolvent(tok, esc);
    }

    /// The unguarded entries are reachable from a callback but move no funds: a re-request restarts a full 48h clock,
    /// a cancel only removes the provider's deadline, a session only extends.
    function test_reentrantToken_unguardedEntriesAreReachableButHarmless() public {
        (Mal_ReentrantToken tok, TapeAPIEscrow esc) = _reentrantSetup();
        vm.prank(consumer); esc.fund(provider, CHANNEL);
        uint64 exp = uint64(block.timestamp + 1 hours);
        bytes memory sig = _sig(esc, CONSUMER_PK, consumer, 10 * UNIT, exp);

        // during a third-party settle: token re-arms its own request -> clock restarts at now
        tok.arm(Mal_ReentrantToken.Target.RequestWithdraw, true, false, false);
        esc.settle(consumer, provider, 10 * UNIT, exp, sig);
        assertTrue(tok.lastOk(), "requestWithdraw is not guarded (by design)");
        (uint256 amt, uint64 at) = esc.pendingWithdraw(address(tok), provider);
        assertEq(amt, 1); assertEq(at, block.timestamp);
        vm.prank(address(tok));
        vm.expectRevert(abi.encodeWithSelector(CooldownActive.selector, uint64(block.timestamp + 48 hours)));
        esc.withdraw(provider);

        // during a settle: cancel and authorize
        exp = uint64(block.timestamp + 1 hours);
        tok.arm(Mal_ReentrantToken.Target.CancelWithdraw, true, false, false);
        esc.settle(consumer, provider, 20 * UNIT, exp, _sig(esc, CONSUMER_PK, consumer, 20 * UNIT, exp));
        assertTrue(tok.lastOk());
        (amt,) = esc.pendingWithdraw(address(tok), provider);
        assertEq(amt, 0);
        tok.arm(Mal_ReentrantToken.Target.AuthorizeSession, true, false, false);
        esc.settle(consumer, provider, 30 * UNIT, exp, _sig(esc, CONSUMER_PK, consumer, 30 * UNIT, exp));
        assertTrue(tok.lastOk());
        assertEq(esc.sessionExpiry(address(tok), provider, address(0xBEEF)), block.timestamp + 1);
        assertEq(esc.claimedOf(consumer, provider), 30 * UNIT);
        _assertSolvent(tok, esc);
    }

    // ---------------------------------------------------------------------------------------------
    // false-returning token / 返回 false 的代币
    // ---------------------------------------------------------------------------------------------

    function test_falseToken_everyLegRevertsTransferFailedAtomically() public {
        Mal_FalseToken tok = new Mal_FalseToken();
        TapeAPIEscrow esc = new TapeAPIEscrow(address(tok), address(hub), treasury);
        tok.mint(consumer, 10 * CHANNEL);
        vm.prank(consumer); tok.approve(address(esc), type(uint256).max);

        // pull leg / 收款
        tok.setFalse(false, true, address(0));
        vm.prank(consumer);
        vm.expectRevert(TransferFailed.selector);
        esc.fund(provider, CHANNEL);
        assertEq(esc.channelOf(consumer, provider), 0, "no credit without tokens");

        tok.setFalse(false, false, address(0));
        vm.prank(consumer); esc.fund(provider, CHANNEL);
        vm.prank(holder); esc.setContribution(address(nft), TOKEN, 1000);
        uint64 exp = uint64(block.timestamp + 1 hours);
        bytes memory sig = _sig(esc, CONSUMER_PK, consumer, 100 * UNIT, exp);

        // provider leg / 付给提供者
        tok.setFalse(true, false, provider);
        vm.expectRevert(TransferFailed.selector);
        esc.settle(consumer, provider, 100 * UNIT, exp, sig);
        assertEq(esc.claimedOf(consumer, provider), 0);
        assertEq(esc.channelOf(consumer, provider), CHANNEL);
        assertEq(esc.treasuryAccrued(), 0, "the accrual rolled back with the provider leg");
        // treasury leg (v3 pull): it no longer exists inside settle, so a treasury the token refuses cannot fail it.
        // Until v2 this exact case rolled the whole settle back. / 金库一腿（v3 拉取式）：settle 内已无此腿，
        // 代币拒绝向金库转账也无法让结算失败；v2 中这一情形会让整笔结算回滚。
        tok.setFalse(true, false, treasury);
        esc.settle(consumer, provider, 100 * UNIT, exp, sig);
        assertEq(tok.balanceOf(provider), 90 * UNIT, "provider paid while the treasury is refused");
        assertEq(esc.treasuryAccrued(), 10 * UNIT);
        // only the claim fails, atomically / 只有领取失败，且原子回滚
        vm.expectRevert(TransferFailed.selector);
        esc.claimTreasury();
        assertEq(esc.treasuryAccrued(), 10 * UNIT, "a failed claim keeps the accrual");
        assertEq(tok.balanceOf(treasury), 0);

        // withdraw leg / 提现
        vm.prank(consumer); esc.requestWithdraw(provider, CHANNEL - 100 * UNIT);
        vm.warp(block.timestamp + 48 hours);
        tok.setFalse(true, false, consumer);
        vm.prank(consumer);
        vm.expectRevert(TransferFailed.selector);
        esc.withdraw(provider);
        (uint256 amt,) = esc.pendingWithdraw(consumer, provider);
        assertEq(amt, CHANNEL - 100 * UNIT, "request survives");
        assertEq(tok.balanceOf(address(esc)), esc.channelOf(consumer, provider) + esc.treasuryAccrued());

        // and once the token behaves, the request and the claim work / 代币恢复后请求与领取可用
        tok.setFalse(false, false, address(0));
        esc.claimTreasury();
        assertEq(tok.balanceOf(treasury), 10 * UNIT);
        vm.prank(consumer); esc.withdraw(provider);
        assertEq(tok.balanceOf(consumer), 10 * CHANNEL - 100 * UNIT, "the rest of the channel after the settle");
        assertEq(tok.balanceOf(address(esc)), 0);
    }

    // ---------------------------------------------------------------------------------------------
    // no-return-value token / 无返回值代币
    // ---------------------------------------------------------------------------------------------

    function test_noReturnToken_fullLifecycleIsSolvent() public {
        Mal_NoReturnToken tok = new Mal_NoReturnToken();
        TapeAPIEscrow esc = new TapeAPIEscrow(address(tok), address(hub), treasury);
        tok.mint(consumer, CHANNEL);
        vm.prank(consumer); tok.approve(address(esc), type(uint256).max);
        vm.prank(consumer); esc.fund(provider, CHANNEL);
        vm.prank(holder); esc.setContribution(address(nft), TOKEN, 333);

        vm.prank(consumer); esc.requestWithdraw(provider, CHANNEL);
        uint64 exp = uint64(block.timestamp + 1 days);
        esc.settle(consumer, provider, 600 * UNIT, exp, _sig(esc, CONSUMER_PK, consumer, 600 * UNIT, exp));
        uint256 contribution = 600 * UNIT * 333 / 10_000;
        assertEq(tok.balanceOf(provider), 600 * UNIT - contribution);
        assertEq(esc.treasuryAccrued(), contribution);
        assertEq(tok.balanceOf(address(esc)), esc.channelOf(consumer, provider) + esc.treasuryAccrued());

        vm.warp(block.timestamp + 48 hours);
        vm.prank(consumer); esc.withdraw(provider);
        assertEq(tok.balanceOf(consumer), 400 * UNIT, "min(requested, channel)");
        esc.claimTreasury();
        assertEq(tok.balanceOf(treasury), contribution);
        assertEq(tok.balanceOf(address(esc)), 0);

        // a no-return token that REVERTS (insufficient allowance) is still caught / 回滚型失败仍被捕获
        vm.prank(consumer); tok.approve(address(esc), 0);
        tok.mint(consumer, 1);
        vm.prank(consumer);
        vm.expectRevert(TransferFailed.selector);
        esc.fund(provider, 1);
    }

    /// A "token" with no code returns success and empty data to a CALL; `_callToken` must refuse it.
    function test_codelessToken_isRefused() public {
        TapeAPIEscrow esc = new TapeAPIEscrow(address(0xC0DE1E55), address(hub), treasury);
        vm.prank(consumer);
        vm.expectRevert(TransferFailed.selector);
        esc.fund(provider, 1);
    }

    // ---------------------------------------------------------------------------------------------
    // fee-on-transfer (UNSUPPORTED) / 转账收费代币（不支持）
    // ---------------------------------------------------------------------------------------------

    /// Documented as unsupported (docs/AUDIT-escrow-v2.md A2-05; BEM is fixed and is not FoT). Pin HOW it breaks:
    /// the identity `balanceOf(escrow) == Σ channel` is short by exactly the fee after each `fund`, providers
    /// receive `pay - contribution - fee`, and the shortfall lands on whoever withdraws last.
    function test_feeOnTransfer_solvencyIdentityBreaksAsDocumented() public {
        Mal_FeeOnTransferToken tok = new Mal_FeeOnTransferToken(100);   // 1%
        TapeAPIEscrow esc = new TapeAPIEscrow(address(tok), address(hub), treasury);
        // one payout leg, so the shortfall below is the token's fee alone (the default 1% contribution would add a
        // second leg) / 只留一条付款腿，下面的差额只来自代币自身的转账费（默认 1% 贡献会多出一条腿）
        vm.prank(holder); esc.setContribution(address(nft), TOKEN, 0);
        tok.mint(consumer, CHANNEL);
        tok.mint(consumer2, CHANNEL);
        vm.prank(consumer); tok.approve(address(esc), type(uint256).max);
        vm.prank(consumer2); tok.approve(address(esc), type(uint256).max);

        vm.prank(consumer); esc.fund(provider, CHANNEL);
        vm.prank(consumer2); esc.fund(provider, CHANNEL);
        uint256 fee = tok.feeOf(CHANNEL);
        uint256 sumCh = esc.channelOf(consumer, provider) + esc.channelOf(consumer2, provider);
        assertEq(sumCh, 2 * CHANNEL, "credited the requested amount");
        assertEq(tok.balanceOf(address(esc)), sumCh - 2 * fee, "identity short by exactly the fees");
        assertTrue(tok.balanceOf(address(esc)) != sumCh, "the solvency identity does NOT hold for FoT tokens");

        // provider is short-paid by the transfer fee on its leg / 提供者少收转账费
        uint64 exp = uint64(block.timestamp + 1 hours);
        esc.settle(consumer, provider, 100 * UNIT, exp, _sig(esc, CONSUMER_PK, consumer, 100 * UNIT, exp));
        assertEq(tok.balanceOf(provider), 100 * UNIT - tok.feeOf(100 * UNIT));
        assertEq(esc.claimedOf(consumer, provider), 100 * UNIT, "ledger says paid in full");

        // first exit succeeds (using the other consumer's money); the last exit is short / 先走的人拿走别人的钱
        uint256 rest = esc.channelOf(consumer, provider);
        vm.prank(consumer); esc.requestWithdraw(provider, rest);
        vm.prank(consumer2); esc.requestWithdraw(provider, CHANNEL);
        vm.warp(block.timestamp + 48 hours);
        vm.prank(consumer); esc.withdraw(provider);
        assertLt(tok.balanceOf(address(esc)), esc.channelOf(consumer2, provider), "escrow cannot cover the last channel");
        vm.prank(consumer2);
        vm.expectRevert(TransferFailed.selector);
        esc.withdraw(provider);
    }

    // ---------------------------------------------------------------------------------------------
    // v3 pull: claimTreasury is guarded, and a treasury that cannot receive never blocks settle
    // v3 拉取式：claimTreasury 受重入锁保护；收不了款的金库永远不阻塞结算
    // ---------------------------------------------------------------------------------------------

    /// claimTreasury from inside settle / withdraw / fund payouts is Reentrancy; and claimTreasury's own transfer
    /// re-entering claimTreasury (double claim), settle, withdraw or fund is Reentrancy. The treasury is paid once.
    /// 在 settle / withdraw / fund 的转账中重入 claimTreasury 回滚 Reentrancy；claimTreasury 自己的转账重入
    /// claimTreasury（重复领取）、settle、withdraw、fund 也回滚 Reentrancy；金库只被付一次。
    function test_reentrantToken_claimTreasury_guardedBothWays() public {
        (Mal_ReentrantToken tok, TapeAPIEscrow esc) = _reentrantSetup();
        vm.prank(consumer); esc.fund(provider, CHANNEL);
        uint64 exp = uint64(block.timestamp + 1 hours);
        // accrue something first / 先产生应收额
        esc.settle(consumer, provider, 100 * UNIT, exp, _sig(esc, CONSUMER_PK, consumer, 100 * UNIT, exp));
        uint256 accrued = esc.treasuryAccrued();
        assertGt(accrued, 0);

        // (1) from settle's payout into claimTreasury / 从 settle 的付款重入 claimTreasury
        tok.arm(Mal_ReentrantToken.Target.ClaimTreasury, true, false, false);
        esc.settle(consumer, provider, 200 * UNIT, exp, _sig(esc, CONSUMER_PK, consumer, 200 * UNIT, exp));
        _assertReentrancy(tok);
        assertEq(tok.balanceOf(treasury), 0, "nothing claimed from inside settle");
        accrued = esc.treasuryAccrued();
        // (2) from fund's pull into claimTreasury / 从 fund 的划转重入 claimTreasury
        tok.arm(Mal_ReentrantToken.Target.ClaimTreasury, false, true, false);
        vm.prank(consumer); esc.fund(provider, 1);
        _assertReentrancy(tok);
        assertEq(esc.treasuryAccrued(), accrued);
        _assertSolvent(tok, esc);

        // (3) claimTreasury's own transfer re-enters each guarded entry / claimTreasury 自己的转账重入各受保护入口
        Mal_ReentrantToken.Target[4] memory ts = [
            Mal_ReentrantToken.Target.ClaimTreasury, Mal_ReentrantToken.Target.Settle,
            Mal_ReentrantToken.Target.Withdraw, Mal_ReentrantToken.Target.Fund
        ];
        vm.warp(block.timestamp + 48 hours);   // token's own request is executable: a missing guard would pay it
        exp = uint64(block.timestamp + 1 hours);
        for (uint256 i = 0; i < 4; i++) {
            uint256 cum = (3 + i) * 100 * UNIT;
            tok.setVoucher(consumer, provider, cum, exp, _sig(esc, CONSUMER_PK, consumer, cum, exp));
            tok.arm(Mal_ReentrantToken.Target.None, false, false, false);
            esc.settle(consumer, provider, cum - 50 * UNIT, exp, _sig(esc, CONSUMER_PK, consumer, cum - 50 * UNIT, exp));
            uint256 a = esc.treasuryAccrued();
            uint256 tBefore = tok.balanceOf(treasury);
            uint256 claimedBefore = esc.claimedOf(consumer, provider);
            uint256 chTok = esc.channelOf(address(tok), provider);
            tok.arm(ts[i], true, false, false);
            uint256 got = esc.claimTreasury();
            _assertReentrancy(tok);
            assertEq(got, a);
            assertEq(tok.balanceOf(treasury) - tBefore, a, "treasury paid exactly once");
            assertEq(esc.treasuryAccrued(), 0);
            assertEq(esc.claimedOf(consumer, provider), claimedBefore, "no settle inside claimTreasury");
            assertEq(esc.channelOf(address(tok), provider), chTok, "no withdraw / fund inside claimTreasury");
            _assertSolvent(tok, esc);
        }
    }

    /// A blocklisted (frozen) treasury: settle keeps working and keeps accruing; claimTreasury reverts
    /// TransferFailed and changes nothing; after the owner rotates, the SAME accrual is paid to the new treasury.
    /// This is the failure mode the pull pattern exists for (v2: every provider at the default 1% stopped settling).
    /// 金库被拉黑（冻结）：结算照常并继续记账；claimTreasury 回滚 TransferFailed 且不改任何状态；owner 更换金库后
    /// 同一笔应收付给新金库。这正是拉取式要解决的故障（v2 中所有保留默认 1% 的提供者都会无法结算）。
    function test_blockedTreasury_settleStillSucceeds_claimAfterRotation() public {
        Mal_BlocklistToken tok = new Mal_BlocklistToken();
        TapeAPIEscrow esc = new TapeAPIEscrow(address(tok), address(hub), treasury);
        tok.mint(consumer, CHANNEL);
        vm.prank(consumer); tok.approve(address(esc), type(uint256).max);
        vm.prank(consumer); esc.fund(provider, CHANNEL);
        tok.setBlocked(treasury, true);                                  // provider stays at the default 1%

        uint64 exp = uint64(block.timestamp + 1 hours);
        esc.settle(consumer, provider, 100 * UNIT, exp, _sig(esc, CONSUMER_PK, consumer, 100 * UNIT, exp));
        esc.settle(consumer, provider, 300 * UNIT, exp, _sig(esc, CONSUMER_PK, consumer, 300 * UNIT, exp));
        assertEq(tok.balanceOf(provider), 297 * UNIT, "provider paid in full minus 1% while the treasury is frozen");
        assertEq(esc.treasuryAccrued(), 3 * UNIT);

        vm.expectRevert(TransferFailed.selector);
        esc.claimTreasury();
        assertEq(esc.treasuryAccrued(), 3 * UNIT, "failed claim keeps the accrual");

        address t2 = address(0x7EA6);
        vm.recordLogs();
        esc.setTreasury(t2);                                             // tries the frozen treasury: fails, does not revert
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1, "only TreasuryChanged: the failed payout emits no TreasuryClaimed");
        assertEq(logs[0].topics[0], keccak256("TreasuryChanged(address,address)"));
        assertEq(esc.treasuryAccrued(), 3 * UNIT, "the failed payout keeps the accrual for the role");
        assertEq(esc.treasury(), t2);
        esc.claimTreasury();
        assertEq(tok.balanceOf(t2), 3 * UNIT, "rotation recovers the accrual");
        assertEq(tok.balanceOf(treasury), 0);
        assertEq(tok.balanceOf(address(esc)), esc.channelOf(consumer, provider));
    }

    /// A treasury CONTRACT that rejects the token (receiver hook reverts): settle unaffected, claim fails until it
    /// accepts. A treasury that re-enters during the claim (claimTreasury again, or settle) gets Reentrancy.
    /// 拒收代币的金库合约（收款钩子回滚）：结算不受影响，领取在它接受之前一直失败。领取时重入的金库得到 Reentrancy。
    function test_rejectingOrReenteringTreasuryContract() public {
        Mal_RecipientHookToken tok = new Mal_RecipientHookToken();
        Mal_HostileTreasury ht = new Mal_HostileTreasury();
        TapeAPIEscrow esc = new TapeAPIEscrow(address(tok), address(hub), address(ht));
        ht.setEscrow(esc);
        tok.setHooked(address(ht), true);
        ht.setReject(true);
        tok.mint(consumer, CHANNEL);
        vm.prank(consumer); tok.approve(address(esc), type(uint256).max);
        vm.prank(consumer); esc.fund(provider, CHANNEL);
        uint64 exp = uint64(block.timestamp + 1 hours);

        esc.settle(consumer, provider, 100 * UNIT, exp, _sig(esc, CONSUMER_PK, consumer, 100 * UNIT, exp));
        assertEq(tok.balanceOf(provider), 99 * UNIT, "the rejecting treasury does not block settle");
        vm.expectRevert(TransferFailed.selector);
        esc.claimTreasury();

        // accepts now, and tries to claim twice from inside the claim / 现在接受，并在领取中再领一次
        ht.setReject(false);
        ht.setReenter(abi.encodeCall(TapeAPIEscrow.claimTreasury, ()));
        esc.claimTreasury();
        assertFalse(ht.lastOk());
        assertEq(bytes4(ht.lastErr()), Reentrancy.selector);
        assertEq(ht.received(), 1 * UNIT, "claimed once");
        assertEq(tok.balanceOf(address(ht)), 1 * UNIT);

        // re-entering settle from the claim / 从领取中重入 settle
        esc.settle(consumer, provider, 200 * UNIT, exp, _sig(esc, CONSUMER_PK, consumer, 200 * UNIT, exp));
        bytes memory sig3 = _sig(esc, CONSUMER_PK, consumer, 300 * UNIT, exp);
        ht.setReenter(abi.encodeCall(TapeAPIEscrow.settle, (consumer, provider, 300 * UNIT, exp, sig3)));
        esc.claimTreasury();
        assertFalse(ht.lastOk());
        assertEq(bytes4(ht.lastErr()), Reentrancy.selector);
        assertEq(esc.claimedOf(consumer, provider), 200 * UNIT, "no settle inside the claim");
        assertEq(tok.balanceOf(address(esc)), esc.channelOf(consumer, provider) + esc.treasuryAccrued());
    }

    // ---------------------------------------------------------------------------------------------
    // Excluded by admission (TAPI-22 §3.5): pinned, not defended / 准入标准排除：只钉住，不防御
    // ---------------------------------------------------------------------------------------------

    /// Item 2: a freeze of the ESCROW address stops fund, settle, withdraw and claim on every channel at once; nothing
    /// is lost in the ledger, and everything works again when the freeze is lifted. This is why freezable tokens are
    /// not admitted: the contract has no rescue path by design.
    /// 第 2 项：冻结托管地址会同时停止所有通道的 fund / settle / withdraw / claim；账本不丢，解冻后一切恢复。
    /// 这就是可冻结代币不予准入的原因：合约按设计没有救援路径。
    function test_frozenEscrow_everyPathStops_isWhyFreezableIsExcluded() public {
        Mal_BlocklistToken tok = new Mal_BlocklistToken();
        TapeAPIEscrow esc = new TapeAPIEscrow(address(tok), address(hub), treasury);
        tok.mint(consumer, 2 * CHANNEL);
        vm.prank(consumer); tok.approve(address(esc), type(uint256).max);
        vm.prank(consumer); esc.fund(provider, CHANNEL);
        uint64 exp = uint64(block.timestamp + 3 days);
        esc.settle(consumer, provider, 100 * UNIT, exp, _sig(esc, CONSUMER_PK, consumer, 100 * UNIT, exp));
        vm.prank(consumer); esc.requestWithdraw(provider, 100 * UNIT);
        vm.warp(block.timestamp + 48 hours);

        tok.setBlocked(address(esc), true);
        bytes memory sig = _sig(esc, CONSUMER_PK, consumer, 200 * UNIT, exp);
        vm.prank(consumer); vm.expectRevert(TransferFailed.selector); esc.fund(provider, 1);
        vm.expectRevert(TransferFailed.selector); esc.settle(consumer, provider, 200 * UNIT, exp, sig);
        vm.prank(consumer); vm.expectRevert(TransferFailed.selector); esc.withdraw(provider);
        vm.expectRevert(TransferFailed.selector); esc.claimTreasury();

        tok.setBlocked(address(esc), false);
        esc.settle(consumer, provider, 200 * UNIT, exp, sig);
        vm.prank(consumer); esc.withdraw(provider);
        esc.claimTreasury();
        assertEq(tok.balanceOf(address(esc)), esc.channelOf(consumer, provider), "ledger intact after the freeze");
    }

    /// Item 2, the pause race (TAPI-22 §3.5): requestWithdraw does not touch the token, so the cooldown runs out while
    /// every settle reverts; at unpause the consumer's withdraw and the provider's settle race for the same funds, and
    /// whoever is mined first wins. The contract cannot fix this without a rescue/override path it deliberately does
    /// not have, so pausable tokens are excluded instead.
    /// 第 2 项，暂停竞态：requestWithdraw 不碰代币，冷静期在所有 settle 回滚时走完；解除暂停时消费者的 withdraw 与
    /// 提供者的 settle 抢同一笔钱，先上链者赢。合约若要修复就需要它刻意没有的干预路径，所以改为排除可暂停代币。
    function test_pausedToken_withdrawRace_isWhyPausableIsExcluded() public {
        Mal_BlocklistToken tok = new Mal_BlocklistToken();
        TapeAPIEscrow esc = new TapeAPIEscrow(address(tok), address(hub), treasury);
        vm.prank(holder); esc.setContribution(address(nft), TOKEN, 0);
        tok.mint(consumer, CHANNEL);
        vm.prank(consumer); tok.approve(address(esc), type(uint256).max);
        vm.prank(consumer); esc.fund(provider, CHANNEL);
        uint64 exp = uint64(block.timestamp + 5 days);
        bytes memory owed = _sig(esc, CONSUMER_PK, consumer, CHANNEL, exp);   // provider served the whole channel

        vm.prank(consumer); esc.requestWithdraw(provider, CHANNEL);         // no token call: works during a pause
        tok.setPaused(true);
        vm.warp(block.timestamp + 1 hours);
        vm.expectRevert(TransferFailed.selector);
        esc.settle(consumer, provider, CHANNEL, exp, owed);                  // the provider does its duty, and fails
        vm.warp(block.timestamp + 48 hours);                                 // the cooldown runs out during the pause
        tok.setPaused(false);
        vm.prank(consumer); esc.withdraw(provider);                          // mined first at unpause
        vm.expectRevert(InsufficientBalance.selector);
        esc.settle(consumer, provider, CHANNEL, exp, owed);
        assertEq(tok.balanceOf(provider), 0, "the provider that settled inside the cooldown is not paid");
    }

    /// Item 3, rebasing: a positive rebase on the escrow is surplus (like a donation: stays, no sweep, every exit still
    /// works); a negative rebase leaves the escrow owing more than it holds and the last exit reverts.
    /// 第 3 项，变基：正变基是盈余（同捐赠：留在原处，所有退出照常）；负变基让托管欠的多于持有的，最后一个退出回滚。
    function test_rebasingToken_positiveIsSurplus_negativeShortsTheLastExit() public {
        Mal_RebaseToken tok = new Mal_RebaseToken();
        TapeAPIEscrow esc = new TapeAPIEscrow(address(tok), address(hub), treasury);
        tok.mint(consumer, CHANNEL);
        tok.mint(consumer2, CHANNEL);
        vm.prank(consumer); tok.approve(address(esc), type(uint256).max);
        vm.prank(consumer2); tok.approve(address(esc), type(uint256).max);
        vm.prank(consumer); esc.fund(provider, CHANNEL);
        vm.prank(consumer2); esc.fund(provider, CHANNEL);

        tok.rebase(address(esc), int256(7 * UNIT));
        assertGt(tok.balanceOf(address(esc)), 2 * CHANNEL, "positive rebase: holds more than it owes");
        tok.rebase(address(esc), -int256(7 * UNIT + 1));                     // net: 1 unit short
        vm.prank(consumer); esc.requestWithdraw(provider, CHANNEL);
        vm.prank(consumer2); esc.requestWithdraw(provider, CHANNEL);
        vm.warp(block.timestamp + 48 hours);
        vm.prank(consumer); esc.withdraw(provider);
        vm.prank(consumer2);
        vm.expectRevert(TransferFailed.selector);
        esc.withdraw(provider);
    }

    // ---------------------------------------------------------------------------------------------
    // `_tokenCall` judge: the paired defences and the revert path / 判定函数：成对的防线与回滚路径
    // ---------------------------------------------------------------------------------------------

    /// Guards the pair "zero the scratch word before the call" + "size >= 32" (docs/AUDIT-escrow-v3.md section 9.5,
    /// F3a / F3b): each alone is equivalent, so only removing BOTH is observable, and only this setup shows it.
    /// In `settle`, scratch word 0x00 still holds the last mapping key, the provider address, whose low byte here is
    /// 0x01. A token that answers 31 zero bytes overwrites bytes 0..30 and leaves byte 31 untouched: without the
    /// zeroing AND without the size rule the judge would read the word `1` and call it success. It must be
    /// `TransferFailed()`, and nothing may move.
    /// 守卫"调用前清零 scratch" + "size >= 32"这一对（F3a / F3b 各自等价，只有同时去掉才可观察）：settle 里 scratch
    /// 仍存着最后一个映射键即提供者地址，其低字节为 0x01；返回 31 个零字节的代币只覆盖前 31 字节，第 32 字节保持 0x01。
    /// 两道防线同时没有时判定函数会读到 1 并判成功。必须 `TransferFailed()` 且不动任何状态。
    function test_scratchDirty_providerLowByte01_31zeroBytes_isTransferFailed() public {
        address p01 = address(uint160(0xaBCdEf0000000000000000000000000000000001));
        Scratch_FixedHub fixedHub = new Scratch_FixedHub(p01);
        Mal_ERC20 good = new Mal_ERC20();
        TapeAPIEscrow esc = new TapeAPIEscrow(address(good), address(fixedHub), treasury);
        good.mint(consumer, CHANNEL);
        vm.prank(consumer); good.approve(address(esc), type(uint256).max);
        vm.prank(consumer); esc.fund(p01, CHANNEL);
        vm.etch(address(good), address(new Scratch_ShortZeroReturn()).code);   // from now on: 31 zero bytes

        uint64 exp = uint64(block.timestamp + 1 hours);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(CONSUMER_PK, esc.voucherDigest(consumer, p01, 5 * UNIT, exp));
        vm.expectRevert(TransferFailed.selector);
        esc.settle(consumer, p01, 5 * UNIT, exp, abi.encodePacked(r, s, v));
        assertEq(esc.channelOf(consumer, p01), CHANNEL, "nothing moved");
        assertEq(esc.claimedOf(consumer, p01), 0);
        assertEq(esc.treasuryAccrued(), 0);
    }

    /// A call that REVERTED is a failure whatever it returned: revert data of exactly the canonical `true` word, and
    /// empty revert data (which a no-return token's success would also look like), on the pull leg (fund) and the
    /// push legs (settle, claimTreasury, withdraw). Second, independent guard of "ignore `!ok`" (the first is
    /// `test_R19_revertingToken_isTransferFailed_whateverItsRevertData`).
    /// 回滚的调用无论返回什么都是失败：回滚数据恰为规范 `true` 的字，或为空（无返回值代币的成功也长这样）；
    /// 拉（fund）与推（settle、claimTreasury、withdraw）各条腿都是。"忽略 !ok"变异的第二道守卫。
    function test_revertingToken_neverCountsAsSuccess_whateverItReverts() public {
        Mal_ERC20 good = new Mal_ERC20();
        TapeAPIEscrow esc = new TapeAPIEscrow(address(good), address(hub), treasury);
        good.mint(consumer, 2 * CHANNEL);
        vm.prank(consumer); good.approve(address(esc), type(uint256).max);
        vm.prank(consumer); esc.fund(provider, CHANNEL);
        vm.prank(holder); esc.setContribution(address(nft), TOKEN, 500);
        uint64 exp = uint64(block.timestamp + 1 hours);
        esc.settle(consumer, provider, 100 * UNIT, exp, _sig(esc, CONSUMER_PK, consumer, 100 * UNIT, exp));
        uint256 accrued = esc.treasuryAccrued();
        assertGt(accrued, 0);
        vm.prank(consumer); esc.requestWithdraw(provider, 50 * UNIT);
        vm.warp(block.timestamp + 48 hours);
        uint256 ch = esc.channelOf(consumer, provider);
        uint64 exp2 = uint64(block.timestamp + 1 days);                            // the 48 h warp outlived `exp`
        bytes memory sig200 = _sig(esc, CONSUMER_PK, consumer, 200 * UNIT, exp2);   // signed before any expectRevert

        bytes memory goodCode = address(good).code;
        bytes[2] memory bad = [
            address(new Scratch_RevertsWithOne()).code,
            address(new Scratch_RevertsWithNothing()).code
        ];
        for (uint256 i; i < 2; i++) {
            vm.etch(address(good), bad[i]);
            vm.prank(consumer);
            vm.expectRevert(TransferFailed.selector);
            esc.fund(provider, 1);
            vm.expectRevert(TransferFailed.selector);
            esc.settle(consumer, provider, 200 * UNIT, exp2, sig200);
            vm.expectRevert(TransferFailed.selector);
            esc.claimTreasury();
            vm.prank(consumer);
            vm.expectRevert(TransferFailed.selector);
            esc.withdraw(provider);
            assertEq(esc.channelOf(consumer, provider), ch, "nothing moved");
            assertEq(esc.treasuryAccrued(), accrued, "nothing moved");
        }
        vm.etch(address(good), goodCode);   // control: the same calls succeed once the token behaves again
        esc.claimTreasury();
        assertEq(good.balanceOf(treasury), accrued);
    }
}
