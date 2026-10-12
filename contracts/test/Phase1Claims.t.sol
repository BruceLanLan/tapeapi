// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Container agents, phase 1 (experimental): nine cases from a review of the phase-1 design (2026-10-06). They pin,
// against the UNCHANGED v3 escrow, the claims the design makes about session keys, channels and the withdraw clock;
// each is CONFIRMED P1RV-01 to 09 in the order below. A test-local deployment only: nothing is broadcast.
// 阶段 1（实验性）：对阶段 1 设计的一次审查留下的 9 个用例（2026-10-06）。在未改的 v3 托管上钉住设计关于会话钥匙、通道与提现时钟的说法；
// 依次为 CONFIRMED P1RV-01 至 09。只是测试内部署，不广播。
import "forge-std/Test.sol";
import {TapeAPIEscrow} from "../src/TapeAPIEscrow.sol";
import {BadSignature, InsufficientBalance, WithdrawWindowClosed, CooldownActive} from "../src/interfaces.sol";
import {Mal_ERC20, Mal_Hub} from "./mocks/MaliciousTokens.sol";

contract Phase1ClaimsTest is Test {
    Mal_ERC20 token;
    TapeAPIEscrow esc;
    address treasury = address(0x70);
    // the principal is a CONTRACT (container stand-in): it never signs, it only calls the escrow (as `execute` would)
    address principal = address(new Phase1ClaimsDummy());
    address p1 = address(0xA1);      // scope provider 1
    address p2 = address(0xA2);      // scope provider 2
    address agentC = address(0xA9);  // the agent's own container (fee channel provider)
    uint256 agentKeyPk = 0xA6E7;
    address agentKey;
    address attacker = address(0xBAD);
    uint64 S;                        // mandate.expires == sessionExpiry

    function setUp() public {
        token = new Mal_ERC20();
        esc = new TapeAPIEscrow(address(token), address(new Mal_Hub()), treasury);
        agentKey = vm.addr(agentKeyPk);
        vm.warp(1_800_000_000);
        S = uint64(block.timestamp + 7 days);
        token.mint(principal, 1_000e8);
        vm.startPrank(principal);
        token.approve(address(esc), 300e8);
        esc.fund(p1, 100e8);
        esc.fund(p2, 100e8);
        esc.fund(agentC, 100e8);                    // fee channel: NO session for agentKey here
        esc.authorizeSession(p1, agentKey, S);
        esc.authorizeSession(p2, agentKey, S);
        vm.stopPrank();
    }

    function _voucher(address consumer, address provider, uint256 cumulative, uint64 expires, uint256 pk) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, esc.voucherDigest(consumer, provider, cumulative, expires));
        return abi.encodePacked(r, s, v);
    }

    /// Claim §2.6: whoever holds agentKey drains BOTH scope channels in one transaction, without any provider's help.
    function test_P1RV01_leakedKey_drainsEveryScopeChannel_inOneTx_noProviderNeeded() public {
        bytes memory s1 = _voucher(principal, p1, 100e8, S, agentKeyPk);
        bytes memory s2 = _voucher(principal, p2, 100e8, S, agentKeyPk);
        vm.startPrank(attacker);                    // anyone may call settle
        esc.settle(principal, p1, 100e8, S, s1);
        esc.settle(principal, p2, 100e8, S, s2);
        vm.stopPrank();
        assertEq(esc.channelOf(principal, p1), 0);
        assertEq(esc.channelOf(principal, p2), 0);
        assertEq(token.balanceOf(p1), 99e8);        // 1% default contribution accrued
        assertEq(token.balanceOf(p2), 99e8);
        assertEq(token.balanceOf(attacker), 0);     // griefing only, unless the attacker IS a scope provider
    }

    /// Claim G2/G5: the key cannot pay anyone outside the channels it was authorised on: not the attacker, not the agent's
    /// fee channel, not a channel of another consumer. The attacker cannot create a (principal, attacker) channel either.
    function test_P1RV02_leakedKey_cannotRedirect_toAttacker_orFeeChannel() public {
        // (principal, attacker): no channel, no session -> BadSignature (session check precedes the balance check)
        bytes memory vA = _voucher(principal, attacker, 1, S, agentKeyPk);
        vm.expectRevert(BadSignature.selector);
        esc.settle(principal, attacker, 1, S, vA);
        // fee channel (principal, agentC) funded, but agentKey has no session there -> BadSignature
        bytes memory vF = _voucher(principal, agentC, 1, S, agentKeyPk);
        vm.expectRevert(BadSignature.selector);
        esc.settle(principal, agentC, 1, S, vF);
        // the attacker funds a channel toward itself: that is channel[attacker][attacker], not the principal's money
        token.mint(attacker, 5e8);
        vm.startPrank(attacker);
        token.approve(address(esc), 5e8);
        esc.fund(attacker, 5e8);
        vm.stopPrank();
        assertEq(esc.channelOf(principal, attacker), 0);
        // and the attacker cannot authorise agentKey on the principal's channel (msg.sender keyed)
        vm.prank(attacker);
        esc.authorizeSession(p1, agentKey, S);      // succeeds, but on channel[attacker][p1]
        assertEq(esc.sessionExpiry(attacker, p1, agentKey), S);
    }

    /// Claim §2.6 row 3: a full requestWithdraw does NOT stop the key holder: settle still works all through the cooldown.
    /// Only the honest provider's own §3.2(4) rule stops the provider; the contract stops nothing.
    function test_P1RV03_fullRequestWithdraw_isNoBarrierForTheKey() public {
        vm.prank(principal);
        esc.requestWithdraw(p1, 100e8);
        (uint256 amt,) = esc.pendingWithdraw(principal, p1);
        assertEq(amt, 100e8);
        vm.warp(block.timestamp + 47 hours);
        vm.prank(attacker);
        esc.settle(principal, p1, 100e8, S, _voucher(principal, p1, 100e8, S, agentKeyPk));
        assertEq(esc.channelOf(principal, p1), 0);
        // the principal's withdraw at maturity then finds nothing
        vm.warp(block.timestamp + 1 hours);
        vm.prank(principal);
        vm.expectRevert(InsufficientBalance.selector);
        esc.withdraw(p1);
    }

    /// Claim §2.6 row 5 and §3b.2 item 5: after 48h + 7d the request lapses on chain but `pendingWithdraw` STILL REPORTS IT.
    /// A verifier that reads only the view (without the lifetime rule) believes a request is live; a provider applying the
    /// lifetime rule serves again; the key, still live, drains everything. The channel also takes NEW money while lapsed.
    function test_P1RV04_lapsedRequest_stillVisibleInView_moneyExposedAgain() public {
        uint64 t0 = uint64(block.timestamp);
        vm.prank(principal);
        esc.requestWithdraw(p1, 100e8);
        vm.warp(t0 + 48 hours + 7 days + 1);
        vm.prank(principal);
        vm.expectRevert(WithdrawWindowClosed.selector);
        esc.withdraw(p1);
        (uint256 amt, uint64 at) = esc.pendingWithdraw(principal, p1);
        assertEq(amt, 100e8);                        // stale request, still in storage
        assertEq(at, t0);
        // session S = t0 + 7 days has lapsed by now in this scenario (7d < 9d): for a 30-day mandate it would not have
        assertLt(S, block.timestamp);
    }

    /// With a 30-day session the lapse window is INSIDE the session: re-request restarts the clock, key still drains.
    function test_P1RV05_thirtyDaySession_lapseThenDrain() public {
        uint64 S30 = uint64(block.timestamp + 30 days);
        vm.startPrank(principal);
        esc.authorizeSession(p1, agentKey, S30);     // extend-only: S -> S30 is allowed, S30 -> S would revert
        esc.requestWithdraw(p1, 100e8);
        vm.stopPrank();
        vm.warp(block.timestamp + 48 hours + 7 days + 1);
        vm.prank(principal);
        vm.expectRevert(WithdrawWindowClosed.selector);
        esc.withdraw(p1);
        vm.prank(attacker);
        esc.settle(principal, p1, 100e8, S30, _voucher(principal, p1, 100e8, S30, agentKeyPk));
        assertEq(esc.channelOf(principal, p1), 0);
    }

    /// A2-03 (design §2.3 rule 2 / "委托方在撤销窗口内再次 fund"): a top-up while a request is live is withdrawable at
    /// maturity (up to the requested amount) AND is spendable by the key meanwhile; the cooldown does not restart.
    function test_P1RV06_topUpDuringLiveRequest_isBothWithdrawableAndSpendable() public {
        uint64 t0 = uint64(block.timestamp);
        vm.startPrank(principal);
        esc.requestWithdraw(p1, 100e8);
        vm.warp(t0 + 40 hours);
        token.approve(address(esc), 50e8);
        esc.fund(p1, 50e8);                          // top-up; request clock NOT restarted
        vm.stopPrank();
        (, uint64 at) = esc.pendingWithdraw(principal, p1);
        assertEq(at, t0);
        vm.prank(attacker);
        esc.settle(principal, p1, 150e8, S, _voucher(principal, p1, 150e8, S, agentKeyPk));   // key spends everything
        assertEq(esc.channelOf(principal, p1), 0);
    }

    /// Design §2.4: one authorizeSession per channel; sessionExpiry == mandate.expires exactly; settle at S ok, S+1 not.
    function test_P1RV07_sessionEdge_equalsMandateExpires() public {
        vm.warp(S);
        vm.prank(attacker);
        esc.settle(principal, p1, 1e8, S, _voucher(principal, p1, 1e8, S, agentKeyPk));
        vm.warp(uint256(S) + 1);
        bytes memory late = _voucher(principal, p1, 2e8, S + 1, agentKeyPk);
        vm.expectRevert(BadSignature.selector);
        esc.settle(principal, p1, 2e8, S + 1, late);
    }

    /// N-03 / design §2.4 "永不重授权": a voucher signed before, unsettled, revives if the same key is re-authorised later.
    function test_P1RV08_reauthorisingOldKey_revivesOldVoucher() public {
        bytes memory old = _voucher(principal, p1, 100e8, uint64(block.timestamp + 29 days), agentKeyPk);
        vm.warp(uint256(S) + 1);                     // session lapsed
        vm.expectRevert(BadSignature.selector);
        esc.settle(principal, p1, 100e8, uint64(S + 29 days - 7 days), old);
        vm.prank(principal);
        esc.authorizeSession(p1, agentKey, uint64(block.timestamp + 1 days));   // "new mandate, same key"
        vm.prank(attacker);
        esc.settle(principal, p1, 100e8, uint64(S + 29 days - 7 days), old);   // the old voucher settles
        assertEq(esc.channelOf(principal, p1), 0);
    }

    /// cancelWithdraw has no delay: a console that uses requestWithdraw as the "revoke button" can also un-revoke instantly.
    function test_P1RV09_cancelWithdraw_isImmediate() public {
        vm.startPrank(principal);
        esc.requestWithdraw(p1, 100e8);
        esc.cancelWithdraw(p1);
        (uint256 amt,) = esc.pendingWithdraw(principal, p1);
        assertEq(amt, 0);
        vm.stopPrank();
    }
}

contract Phase1ClaimsDummy { }
