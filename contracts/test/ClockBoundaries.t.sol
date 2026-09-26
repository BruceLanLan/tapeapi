// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Deterministic clock-edge tests (docs/research/RESEARCH-process-channels.md 6.1 item 1; RESEARCH-process-security.md
// 6.1 item 11). Four clocks, each pinned at its last valid second and the first invalid one:
//   cooldown   [requestedAt, requestedAt + 48h)          provider-only: withdraw reverts CooldownActive
//   window     [requestedAt + 48h, requestedAt + 48h + 7d] withdraw executable, pays min(requested, channel)
//   voucher    settle valid while block.timestamp <= expires             (+1 -> Expired)
//   session    key valid while sessionExpiry >= block.timestamp           (+1 -> BadSignature)
// plus the "two clocks at once" case (Optimism chess-clock precedent): at exactly requestedAt + 48h both the
// provider's settle and the consumer's withdraw are valid, and the result depends on transaction order.
// 确定性时钟边界测试：四个时钟各自在最后有效秒与第一个无效秒钉桩；外加"两个时钟同时到点"的情形。

import "forge-std/Test.sol";
import {TapeAPIEscrow} from "../src/TapeAPIEscrow.sol";
import {
    Expired, BadSignature, CooldownActive, WithdrawWindowClosed, InsufficientBalance, SessionTooLong,
    SessionShorteningNotSupported
} from "../src/interfaces.sol";
import {Mal_ERC20, Mal_ERC721, Mal_Hub} from "./mocks/MaliciousTokens.sol";

contract ClockBoundariesTest is Test {
    Mal_ERC20 bem;
    Mal_ERC721 nft;
    Mal_Hub hub;
    TapeAPIEscrow escrow;
    address treasury = address(0x7EA5);
    uint256 constant CONSUMER_PK = 0xC0FFEE;
    uint256 constant SESSION_PK = 0x5E55;
    address consumer;
    address sessionKey;
    address provider;
    uint256 constant UNIT = 1e8;
    uint256 constant CHANNEL = 1_000 * UNIT;
    uint64 constant COOLDOWN = 48 hours;
    uint64 constant WINDOW = 7 days;

    event WithdrawRequested(address indexed consumer, address indexed provider, uint256 amount, uint64 availableAt);
    event Withdrawn(address indexed consumer, address indexed provider, uint256 amount);
    event Settled(address indexed consumer, address indexed provider, uint256 paid, uint256 contribution);

    function setUp() public {
        vm.warp(1_758_300_000);
        consumer = vm.addr(CONSUMER_PK);
        sessionKey = vm.addr(SESSION_PK);
        bem = new Mal_ERC20();
        nft = new Mal_ERC721();
        hub = new Mal_Hub();
        provider = hub.accountOf(address(nft), 1);
        escrow = new TapeAPIEscrow(address(bem), address(hub), treasury);
        bem.mint(consumer, 10 * CHANNEL);
        vm.startPrank(consumer);
        bem.approve(address(escrow), type(uint256).max);
        escrow.fund(provider, CHANNEL);
        vm.stopPrank();
    }

    function _sig(uint256 pk, uint256 cum, uint64 exp) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, escrow.voucherDigest(consumer, provider, cum, exp));
        return abi.encodePacked(r, s, v);
    }

    function _request(uint256 amt) internal returns (uint64 t0) {
        t0 = uint64(block.timestamp);
        vm.prank(consumer);
        vm.expectEmit(true, true, false, true);
        emit WithdrawRequested(consumer, provider, amt, t0 + COOLDOWN);
        escrow.requestWithdraw(provider, amt);
    }

    // ---- cooldown: last second belongs to the provider; next second the consumer takes min(requested, channel) ----

    /// Requested >= what the settle leaves: withdraw takes the CHANNEL side of min().
    function test_edge_cooldownLastSecondSettle_nextSecondWithdrawTakesChannel() public {
        uint64 t0 = _request(CHANNEL);
        uint64 exp = t0 + 30 days;
        bytes memory sig = _sig(CONSUMER_PK, 600 * UNIT, exp);

        vm.warp(t0 + COOLDOWN - 1);                                   // last second of the cooldown
        vm.prank(consumer);
        vm.expectRevert(abi.encodeWithSelector(CooldownActive.selector, t0 + COOLDOWN));
        escrow.withdraw(provider);
        escrow.settle(consumer, provider, 600 * UNIT, exp, sig);      // provider settles in time
        assertEq(bem.balanceOf(provider), 600 * UNIT, "provider paid in full at the last second");

        vm.warp(t0 + COOLDOWN);                                       // first second of the window
        uint256 before = bem.balanceOf(consumer);
        vm.prank(consumer);
        vm.expectEmit(true, true, false, true);
        emit Withdrawn(consumer, provider, 400 * UNIT);
        escrow.withdraw(provider);
        assertEq(bem.balanceOf(consumer) - before, 400 * UNIT, "min(requested=1000, channel=400) = 400");
        assertEq(escrow.channelOf(consumer, provider), 0);
        assertEq(bem.balanceOf(address(escrow)), 0);
    }

    /// Requested < what the settle leaves: withdraw takes the REQUESTED side of min(), the rest stays in the channel.
    function test_edge_cooldownLastSecondSettle_nextSecondWithdrawTakesRequested() public {
        uint64 t0 = _request(300 * UNIT);
        uint64 exp = t0 + 30 days;
        vm.warp(t0 + COOLDOWN - 1);
        escrow.settle(consumer, provider, 600 * UNIT, exp, _sig(CONSUMER_PK, 600 * UNIT, exp));
        vm.warp(t0 + COOLDOWN);
        uint256 before = bem.balanceOf(consumer);
        vm.prank(consumer);
        escrow.withdraw(provider);
        assertEq(bem.balanceOf(consumer) - before, 300 * UNIT, "min(requested=300, channel=400) = 300");
        assertEq(escrow.channelOf(consumer, provider), 100 * UNIT, "remainder stays settleable");
        (uint256 amt, uint64 at) = escrow.pendingWithdraw(consumer, provider);
        assertEq(amt, 0); assertEq(at, 0);
        // the same voucher's remainder cannot be re-paid, but a higher one can still use what is left
        escrow.settle(consumer, provider, 700 * UNIT, exp, _sig(CONSUMER_PK, 700 * UNIT, exp));
        assertEq(bem.balanceOf(provider), 700 * UNIT);
    }

    /// Two clocks at once: at exactly requestedAt + 48h the provider's settle and the consumer's withdraw are BOTH
    /// valid. Order decides who is paid: this is the documented rule ("settle inside the cooldown", i.e. strictly
    /// before availableAt), not a race the provider can win at availableAt itself.
    /// 两个时钟同时到点：requestedAt + 48h 整秒时两者都有效，结果取决于交易顺序——这正是"须在冷静期内结算"的含义。
    function test_edge_sameSecondAtAvailableAt_settleAndWithdraw_bothOrders() public {
        uint64 t0 = _request(CHANNEL);
        uint64 exp = t0 + 30 days;
        bytes memory sig = _sig(CONSUMER_PK, 600 * UNIT, exp);
        vm.warp(t0 + COOLDOWN);
        uint256 snap = vm.snapshotState();

        // (a) settle lands first: provider paid in full, consumer takes the rest
        escrow.settle(consumer, provider, 600 * UNIT, exp, sig);
        vm.prank(consumer); escrow.withdraw(provider);
        assertEq(bem.balanceOf(provider), 600 * UNIT);
        assertEq(bem.balanceOf(consumer), 10 * CHANNEL - 600 * UNIT);

        vm.revertToState(snap);
        // (b) withdraw lands first: consumer takes the whole requested channel, the voucher finds nothing
        vm.prank(consumer); escrow.withdraw(provider);
        assertEq(bem.balanceOf(consumer), 10 * CHANNEL);
        vm.expectRevert(InsufficientBalance.selector);
        escrow.settle(consumer, provider, 600 * UNIT, exp, sig);
        assertEq(bem.balanceOf(provider), 0, "a provider that waited until availableAt is not protected");
    }

    // ---- voucher expiry: inclusive ----

    function test_edge_voucherExpiresSecond_settles_plusOneExpired() public {
        uint64 exp = uint64(block.timestamp + 1 hours);
        bytes memory s1 = _sig(CONSUMER_PK, 10 * UNIT, exp);
        bytes memory s2 = _sig(CONSUMER_PK, 20 * UNIT, exp);
        vm.warp(exp);
        escrow.settle(consumer, provider, 10 * UNIT, exp, s1);
        assertEq(escrow.claimedOf(consumer, provider), 10 * UNIT, "expires == now settles");
        vm.warp(uint256(exp) + 1);
        vm.expectRevert(Expired.selector);
        escrow.settle(consumer, provider, 20 * UNIT, exp, s2);
    }

    // ---- session expiry: inclusive, independent of the voucher's own expiry ----

    function test_edge_sessionExpirySecond_settles_plusOneBadSignature() public {
        uint64 keyExp = uint64(block.timestamp + 1 days);
        vm.prank(consumer); escrow.authorizeSession(provider, sessionKey, keyExp);
        uint64 exp = keyExp + 1 days;                                 // voucher outlives the key
        bytes memory s1 = _sig(SESSION_PK, 10 * UNIT, exp);
        bytes memory s2 = _sig(SESSION_PK, 20 * UNIT, exp);
        vm.warp(keyExp);
        escrow.settle(consumer, provider, 10 * UNIT, exp, s1);
        assertEq(escrow.claimedOf(consumer, provider), 10 * UNIT, "sessionExpiry == now settles");
        vm.warp(uint256(keyExp) + 1);
        vm.expectRevert(BadSignature.selector);
        escrow.settle(consumer, provider, 20 * UNIT, exp, s2);
        // the consumer's own signature is unaffected by the key's expiry
        escrow.settle(consumer, provider, 20 * UNIT, exp, _sig(CONSUMER_PK, 20 * UNIT, exp));
    }

    /// Voucher and key expire in the same second: at T both valid; at T+1 the error is Expired (checked first).
    function test_edge_voucherAndSessionSameSecond_errorPrecedence() public {
        uint64 t = uint64(block.timestamp + 2 hours);
        vm.prank(consumer); escrow.authorizeSession(provider, sessionKey, t);
        bytes memory s1 = _sig(SESSION_PK, 10 * UNIT, t);
        bytes memory s2 = _sig(SESSION_PK, 20 * UNIT, t);
        vm.warp(t);
        escrow.settle(consumer, provider, 10 * UNIT, t, s1);
        vm.warp(uint256(t) + 1);
        vm.expectRevert(Expired.selector);
        escrow.settle(consumer, provider, 20 * UNIT, t, s2);
    }

    // ---- window: last second executes, +1 is closed ----

    function test_edge_windowLastSecondWithdraws_plusOneWindowClosed() public {
        uint64 t0 = _request(100 * UNIT);
        vm.warp(uint256(t0) + COOLDOWN + WINDOW);                     // last second of the window
        vm.prank(consumer);
        escrow.withdraw(provider);
        assertEq(escrow.channelOf(consumer, provider), CHANNEL - 100 * UNIT);

        uint64 t1 = _request(100 * UNIT);
        vm.warp(uint256(t1) + COOLDOWN + WINDOW + 1);                 // first second after
        vm.prank(consumer);
        vm.expectRevert(WithdrawWindowClosed.selector);
        escrow.withdraw(provider);
        (uint256 amt, uint64 at) = escrow.pendingWithdraw(consumer, provider);
        assertEq(amt, 100 * UNIT); assertEq(at, t1);
        assertEq(escrow.channelOf(consumer, provider), CHANNEL - 100 * UNIT);
    }

    // ---- authorizeSession edges ----

    function test_edge_authorizeSession_bounds() public {
        uint64 nowTs = uint64(block.timestamp);
        uint64 max = nowTs + escrow.MAX_SESSION();
        vm.startPrank(consumer);
        vm.expectRevert(Expired.selector);
        escrow.authorizeSession(provider, sessionKey, nowTs);          // expires == now is not in the future
        vm.expectRevert(abi.encodeWithSelector(SessionTooLong.selector, max));
        escrow.authorizeSession(provider, sessionKey, max + 1);
        escrow.authorizeSession(provider, sessionKey, nowTs + 1);      // now + 1 is fine
        escrow.authorizeSession(provider, sessionKey, max);            // exactly MAX_SESSION is fine
        escrow.authorizeSession(provider, sessionKey, max);            // re-affirming the same expiry is not shortening
        vm.expectRevert(SessionShorteningNotSupported.selector);
        escrow.authorizeSession(provider, sessionKey, max - 1);
        vm.stopPrank();
        assertEq(escrow.sessionExpiry(consumer, provider, sessionKey), max);
    }
}
