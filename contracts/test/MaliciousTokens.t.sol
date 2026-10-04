// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Escrow vs the hostile-token family in test/mocks/MaliciousTokens.sol (RESEARCH-process-security.md 6.1 P0-3).
// Documented behaviour being pinned (TapeAPIEscrow.sol NatSpec, docs/AUDIT-escrow-v2.md A2-05):
//   re-entrancy      fund / settle / withdraw are nonReentrant; re-entering any of them from a token callback
//                    reverts with exactly `Reentrancy()`; the unguarded requestWithdraw / cancelWithdraw /
//                    authorizeSession are reachable but move no funds.
//   false return     `_callToken` treats `false` as failure: the whole call reverts `TransferFailed()`, atomically.
//   no return value  accepted (USDT-style), provided the token address has code.
//   fee-on-transfer  UNSUPPORTED (BEM is fixed and is not FoT): the solvency identity breaks by exactly the fee at
//                    `fund`, and the last withdrawer is the one left short.
// 托管对恶意代币家族的行为钉桩：重入精确回滚 Reentrancy；返回 false 原子地回滚 TransferFailed；
// 无返回值可用；FoT 不受支持——偿付恒等式在 fund 时恰好少 fee，最后一个提现者承担缺口。

import "forge-std/Test.sol";
import {TapeAPIEscrow} from "../src/TapeAPIEscrow.sol";
import {Reentrancy, TransferFailed, NothingToSettle, CooldownActive} from "../src/interfaces.sol";
import {
    Mal_ERC20, Mal_ERC721, Mal_Hub, Mal_ReentrantToken, Mal_FalseToken, Mal_NoReturnToken, Mal_FeeOnTransferToken
} from "./mocks/MaliciousTokens.sol";

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
        vm.prank(holder); esc.setContribution(address(nft), TOKEN, 250);   // two payout legs in settle / settle 两次转账
    }

    function _assertSolvent(Mal_ERC20 tok, TapeAPIEscrow esc) internal view {
        assertEq(
            tok.balanceOf(address(esc)),
            esc.channelOf(consumer, provider) + esc.channelOf(address(tok), provider),
            "escrow balance == sum of channels"
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
            uint256 tBefore = tok.balanceOf(treasury);
            tok.arm(ts[i], true, false, false);
            esc.settle(consumer, provider, cum, exp, sig);
            _assertReentrancy(tok);
            uint256 contribution = 100 * UNIT * 250 / 10_000;
            assertEq(tok.balanceOf(provider) - pBefore, 100 * UNIT - contribution, "provider paid once");
            assertEq(tok.balanceOf(treasury) - tBefore, contribution, "treasury paid once");
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
        // treasury leg: provider leg would succeed, the whole settle still rolls back / 金库一腿失败，整笔回滚
        tok.setFalse(true, false, treasury);
        vm.expectRevert(TransferFailed.selector);
        esc.settle(consumer, provider, 100 * UNIT, exp, sig);
        assertEq(tok.balanceOf(provider), 0, "provider leg rolled back with the treasury leg");
        assertEq(esc.claimedOf(consumer, provider), 0);
        assertEq(esc.channelOf(consumer, provider), CHANNEL);

        // withdraw leg / 提现
        vm.prank(consumer); esc.requestWithdraw(provider, CHANNEL);
        vm.warp(block.timestamp + 48 hours);
        tok.setFalse(true, false, consumer);
        vm.prank(consumer);
        vm.expectRevert(TransferFailed.selector);
        esc.withdraw(provider);
        (uint256 amt,) = esc.pendingWithdraw(consumer, provider);
        assertEq(amt, CHANNEL, "request survives");
        assertEq(tok.balanceOf(address(esc)), esc.channelOf(consumer, provider));

        // and once the token behaves, the same voucher / request work / 代币恢复后同一凭证与请求可用
        tok.setFalse(false, false, address(0));
        exp = uint64(block.timestamp + 1 hours);
        esc.settle(consumer, provider, 100 * UNIT, exp, _sig(esc, CONSUMER_PK, consumer, 100 * UNIT, exp));
        assertEq(tok.balanceOf(provider), 90 * UNIT);
        assertEq(tok.balanceOf(treasury), 10 * UNIT);
        vm.prank(consumer); esc.withdraw(provider);
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
        assertEq(tok.balanceOf(treasury), contribution);
        assertEq(tok.balanceOf(address(esc)), esc.channelOf(consumer, provider));

        vm.warp(block.timestamp + 48 hours);
        vm.prank(consumer); esc.withdraw(provider);
        assertEq(tok.balanceOf(consumer), 400 * UNIT, "min(requested, channel)");
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
}
