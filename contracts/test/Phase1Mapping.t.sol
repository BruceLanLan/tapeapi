// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Container agents, phase 1 (experimental, internal design notes, phase 1): the behaviour of the
// UNCHANGED v3 escrow that the SDK's channel-mapping check (sdk/src/agent-verify.js, { enforcement: 'escrow-channel' })
// relies on, with an 8-decimal token stand-in. The nine scenarios of the design's review (RV) plus the boundaries the
// verifier reads: the session edge (live at S, not at S + 1), sessionExpiry 0 for a key never authorised, the lifetime
// of a withdraw request (live through requestedAt + 48 h + 7 d inclusive, the view kept after it lapses), F1 and F2 as
// two separate channels, and claimedOf as the spent-so-far snapshot. A test-local deployment only: nothing is broadcast.
// 容器代理阶段 1（实验）：SDK 通道映射核验所依赖的、未改动的 v3 托管行为，用 8 位小数的代币替身。RV 的 9 个场景，加上核验方读取的边界：
// 会话在 S 有效、S + 1 无效；从未授权的钥匙 sessionExpiry 为 0；提现请求存活到 requestedAt + 48h + 7d（含）、过期后视图仍在；
// F1 与 F2 是两条不同的通道；claimedOf 是已花快照。只是测试内部署，不广播。
import "forge-std/Test.sol";
import {TapeAPIEscrow} from "../src/TapeAPIEscrow.sol";
import {BadSignature, InsufficientBalance, WithdrawWindowClosed, SessionShorteningNotSupported} from "../src/interfaces.sol";
import {Mal_DecimalsToken, Mal_Hub} from "./mocks/MaliciousTokens.sol";

contract Phase1MappingTest is Test {
    Mal_DecimalsToken token;
    TapeAPIEscrow esc;
    address treasury = address(0x70);
    uint256 holderPk = 0x11;            // F2 (default): the principal's current holder funds from its wallet
    address holder;
    address container = address(new ContainerStandIn());   // F1: the principal container (it calls as `execute` would)
    address p1 = address(0xA1);         // scope provider 1
    address p2 = address(0xA2);         // scope provider 2
    address agentC = address(0xA9);     // the agent's own container (fee channel provider)
    uint256 agentKeyPk = 0xA6E7;
    address agentKey;
    address attacker = address(0xBAD);
    uint64 S;                           // mandate.expires == sessionExpiry
    uint64 constant LIFETIME = 48 hours + 7 days;   // WITHDRAW_COOLDOWN + WITHDRAW_WINDOW

    function setUp() public {
        token = new Mal_DecimalsToken(8);
        esc = new TapeAPIEscrow(address(token), address(new Mal_Hub()), treasury);
        holder = vm.addr(holderPk);
        agentKey = vm.addr(agentKeyPk);
        vm.warp(1_800_000_000);
        S = uint64(block.timestamp + 7 days);
        token.mint(holder, 1_000e8);
        // the holder's plan (escrowPlan, holder path): one exact approve, fund each scope channel at its cap, authorise the
        // agent key on each until S; the fee channel is funded and the agent key is NOT authorised on it
        vm.startPrank(holder);
        token.approve(address(esc), 300e8);
        esc.fund(p1, 100e8);
        esc.fund(p2, 100e8);
        esc.fund(agentC, 100e8);
        esc.authorizeSession(p1, agentKey, S);
        esc.authorizeSession(p2, agentKey, S);
        vm.stopPrank();
    }

    function _voucher(address consumer, address provider, uint256 cumulative, uint64 expires, uint256 pk) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, esc.voucherDigest(consumer, provider, cumulative, expires));
        return abi.encodePacked(r, s, v);
    }
    // what the SDK computes from the view: live = requestedAt != 0 && now <= requestedAt + LIFETIME (R21)
    function _live(address consumer, address provider) internal view returns (bool) {
        (, uint64 at) = esc.pendingWithdraw(consumer, provider);
        return at != 0 && block.timestamp <= uint256(at) + LIFETIME;
    }
    function _available(address consumer, address provider) internal view returns (uint256) {
        (uint256 amt,) = esc.pendingWithdraw(consumer, provider);
        uint256 ch = esc.channelOf(consumer, provider);
        uint256 locked = _live(consumer, provider) ? amt : 0;
        return ch > locked ? ch - locked : 0;
    }

    /// The reads the verifier starts from: token() is the 8-decimal stand-in, the plan left the allowance at 0 except what
    /// was approved beyond the funds, the channels hold their caps, the sessions end at S, the fee channel has no session.
    function test_mappingReads_afterTheHoldersPlan() public view {
        assertEq(address(esc.token()), address(token));
        assertEq(token.decimals(), 8);
        assertEq(esc.channelOf(holder, p1), 100e8);
        assertEq(esc.sessionExpiry(holder, p1, agentKey), S);
        assertEq(esc.sessionExpiry(holder, agentC, agentKey), 0);           // G5: agent-key-on-fee-channel reads 0
        assertEq(esc.sessionExpiry(holder, p1, address(0xC0FFEE)), 0);      // never authorised: 0, the verifier's session-missing
        (uint256 amt, uint64 at) = esc.pendingWithdraw(holder, p1);
        assertEq(amt, 0); assertEq(at, 0);
        assertEq(esc.claimedOf(holder, p1), 0);
        assertEq(token.allowance(holder, address(esc)), 0);                 // approved exactly what was funded
    }

    /// RV 1, §2.6: whoever holds agentKey drains BOTH scope channels in one transaction, without any provider's help.
    /// Afterwards the verifier reads channelOf 0 (channel-empty).
    function test_leakedKey_drainsEveryScopeChannel_inOneTx_noProviderNeeded() public {
        bytes memory s1 = _voucher(holder, p1, 100e8, S, agentKeyPk);
        bytes memory s2 = _voucher(holder, p2, 100e8, S, agentKeyPk);
        vm.startPrank(attacker);
        esc.settle(holder, p1, 100e8, S, s1);
        esc.settle(holder, p2, 100e8, S, s2);
        vm.stopPrank();
        assertEq(esc.channelOf(holder, p1), 0);
        assertEq(esc.channelOf(holder, p2), 0);
        assertEq(token.balanceOf(p1), 99e8);         // 1% default contribution accrued
        assertEq(token.balanceOf(attacker), 0);      // griefing only, unless the attacker IS a scope provider
        assertEq(esc.claimedOf(holder, p1), 100e8);  // spent = claimedOf(t) - claimedOf(t0) (§2.3 rule 5)
    }

    /// RV 2, G2/G5: the key pays no one outside its channels; an attacker's authorizeSession lands on the attacker's own
    /// channel, so the verifier reading (holder, provider) is not fooled.
    function test_leakedKey_cannotRedirect_toAttacker_orFeeChannel() public {
        // the vouchers are signed first: voucherDigest is itself a call, and expectRevert applies to the next one
        bytes memory vA = _voucher(holder, attacker, 1, S, agentKeyPk);
        bytes memory vF = _voucher(holder, agentC, 1, S, agentKeyPk);
        vm.expectRevert(BadSignature.selector);
        esc.settle(holder, attacker, 1, S, vA);
        vm.expectRevert(BadSignature.selector);
        esc.settle(holder, agentC, 1, S, vF);
        address freshKey = address(0xF1);
        vm.prank(attacker);
        esc.authorizeSession(p1, freshKey, S);       // succeeds, but on channel[attacker][p1]
        assertEq(esc.sessionExpiry(attacker, p1, freshKey), S);
        assertEq(esc.sessionExpiry(holder, p1, freshKey), 0);
    }

    /// RV 3, §2.6: a full requestWithdraw does NOT stop the key holder; only honest parties stop (the verifier reports
    /// withdraw-pending and channel-empty: available = channel - live request = 0).
    function test_fullRequestWithdraw_isNoBarrierForTheKey() public {
        vm.prank(holder);
        esc.requestWithdraw(p1, 100e8);
        assertTrue(_live(holder, p1));
        assertEq(_available(holder, p1), 0);
        vm.warp(block.timestamp + 47 hours);
        vm.prank(attacker);
        esc.settle(holder, p1, 100e8, S, _voucher(holder, p1, 100e8, S, agentKeyPk));
        assertEq(esc.channelOf(holder, p1), 0);
        vm.warp(block.timestamp + 1 hours);
        vm.prank(holder);
        vm.expectRevert(InsufficientBalance.selector);
        esc.withdraw(p1);
    }

    /// RV 4, R21: the lifetime boundary the verifier uses. At requestedAt + 48 h + 7 d the request is still executable
    /// (live, inclusive); one second later withdraw reverts WithdrawWindowClosed, yet the view still returns the request.
    function test_lifetimeBoundary_liveInclusive_viewKeptAfterLapse() public {
        uint64 t0 = uint64(block.timestamp);
        vm.prank(holder);
        esc.requestWithdraw(p1, 40e8);
        vm.warp(uint256(t0) + LIFETIME);
        assertTrue(_live(holder, p1));
        uint256 snap = vm.snapshotState();
        vm.prank(holder);
        esc.withdraw(p1);                            // still executable at the last second
        assertEq(esc.channelOf(holder, p1), 60e8);
        vm.revertToState(snap);
        vm.warp(uint256(t0) + LIFETIME + 1);
        vm.prank(holder);
        vm.expectRevert(WithdrawWindowClosed.selector);
        esc.withdraw(p1);
        (uint256 amt, uint64 at) = esc.pendingWithdraw(holder, p1);
        assertEq(amt, 40e8);                         // the lapsed request is still in the view
        assertEq(at, t0);
        assertFalse(_live(holder, p1));              // ...but not live: the whole channel is available again
        assertEq(_available(holder, p1), 100e8);
    }

    /// RV 5: with a 30-day session the lapse is INSIDE the session: the key drains the channel the request no longer protects.
    function test_thirtyDaySession_lapseThenDrain() public {
        uint64 S30 = uint64(block.timestamp + 30 days);
        vm.startPrank(holder);
        esc.authorizeSession(p1, agentKey, S30);     // extend-only: S -> S30 is allowed
        esc.requestWithdraw(p1, 100e8);
        vm.stopPrank();
        vm.warp(block.timestamp + LIFETIME + 1);
        vm.prank(holder);
        vm.expectRevert(WithdrawWindowClosed.selector);
        esc.withdraw(p1);
        assertFalse(_live(holder, p1));
        vm.prank(attacker);
        esc.settle(holder, p1, 100e8, S30, _voucher(holder, p1, 100e8, S30, agentKeyPk));
        assertEq(esc.channelOf(holder, p1), 0);
    }

    /// RV 6, A2-03, R24: a top-up while a request is live: the request's clock does not restart, the channel exceeds the
    /// cap (channel-exceeds-cap), only channel - request is available, and the key can spend all of it.
    function test_topUpDuringLiveRequest_isBothWithdrawableAndSpendable() public {
        uint64 t0 = uint64(block.timestamp);
        vm.startPrank(holder);
        esc.requestWithdraw(p1, 100e8);
        vm.warp(t0 + 40 hours);
        token.approve(address(esc), 50e8);
        esc.fund(p1, 50e8);
        vm.stopPrank();
        (, uint64 at) = esc.pendingWithdraw(holder, p1);
        assertEq(at, t0);
        assertEq(esc.channelOf(holder, p1), 150e8);
        assertEq(_available(holder, p1), 50e8);
        vm.prank(attacker);
        esc.settle(holder, p1, 150e8, S, _voucher(holder, p1, 150e8, S, agentKeyPk));
        assertEq(esc.channelOf(holder, p1), 0);
    }

    /// RV 7, §2.4: sessionExpiry == mandate.expires; settle at S works, at S + 1 it does not (the verifier's session check
    /// is sessionExpiry >= now, and session-missing below now).
    function test_sessionEdge_equalsMandateExpires() public {
        vm.warp(S);
        vm.prank(attacker);
        esc.settle(holder, p1, 1e8, S, _voucher(holder, p1, 1e8, S, agentKeyPk));
        vm.warp(uint256(S) + 1);
        bytes memory late = _voucher(holder, p1, 2e8, S + 1, agentKeyPk);
        vm.expectRevert(BadSignature.selector);
        esc.settle(holder, p1, 2e8, S + 1, late);
    }

    /// §2.4: a session cannot be shortened: a session-expiry-mismatch above the mandate's expiry cannot be repaired on
    /// that key; the console must use a new key.
    function test_sessionCannotBeShortened_newKeyNeeded() public {
        vm.prank(holder);
        vm.expectRevert(SessionShorteningNotSupported.selector);
        esc.authorizeSession(p1, agentKey, S - 1);
        assertEq(esc.sessionExpiry(holder, p1, agentKey), S);
    }

    /// RV 8, N-03, §2.4: a voucher signed before and never settled revives when the same key is authorised again: the
    /// verifier of the new mandate cannot see this (N9); one key per mandate is the console's duty.
    function test_reauthorisingOldKey_revivesOldVoucher() public {
        uint64 vexp = uint64(block.timestamp + 29 days);
        bytes memory old = _voucher(holder, p1, 100e8, vexp, agentKeyPk);
        vm.warp(uint256(S) + 1);
        vm.expectRevert(BadSignature.selector);
        esc.settle(holder, p1, 100e8, vexp, old);
        uint64 S2 = uint64(block.timestamp + 1 days);
        vm.prank(holder);
        esc.authorizeSession(p1, agentKey, S2);      // "a new mandate, the same key"
        assertEq(esc.sessionExpiry(holder, p1, agentKey), S2);   // what the verifier of the new mandate reads: equal, ok
        vm.prank(attacker);
        esc.settle(holder, p1, 100e8, vexp, old);    // the old voucher settles
        assertEq(esc.channelOf(holder, p1), 0);
    }

    /// RV 9, §2.6: cancelWithdraw has no delay: the view is (0, 0) at once, nothing is live, the channel fully available.
    function test_cancelWithdraw_isImmediate() public {
        vm.startPrank(holder);
        esc.requestWithdraw(p1, 100e8);
        esc.cancelWithdraw(p1);
        vm.stopPrank();
        (uint256 amt, uint64 at) = esc.pendingWithdraw(holder, p1);
        assertEq(amt, 0); assertEq(at, 0);
        assertFalse(_live(holder, p1));
        assertEq(_available(holder, p1), 100e8);
    }

    /// §2.1: F1 (the container is the consumer) and F2 (its holder is) are two separate channels with separate sessions:
    /// the verifier must read the one the funding path names.
    function test_f1AndF2_areSeparateChannels() public {
        token.mint(container, 10e8);
        vm.startPrank(container);                    // as the container's execute would call
        token.approve(address(esc), 10e8);
        esc.fund(p1, 10e8);
        esc.authorizeSession(p1, agentKey, S);
        vm.stopPrank();
        assertEq(esc.channelOf(container, p1), 10e8);
        assertEq(esc.channelOf(holder, p1), 100e8);
        // a voucher names its consumer: one for the container's channel never touches the holder's
        vm.prank(attacker);
        esc.settle(container, p1, 10e8, S, _voucher(container, p1, 10e8, S, agentKeyPk));
        assertEq(esc.channelOf(container, p1), 0);
        assertEq(esc.channelOf(holder, p1), 100e8);
    }
}

contract ContainerStandIn { }
