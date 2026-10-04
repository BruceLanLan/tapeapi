// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// ============================================================================================
// Audit round 2 (independent adversarial, v2 per-channel escrow) -- executable evidence.
// Every test either EXECUTES an attack and asserts the precise revert / bounded outcome, or
// executes a DECISION-escrow-v2.md claim end to end. Nothing here trusts an existing test.
// Findings referenced as A2-xx are written up in docs/AUDIT-escrow-v2.md.
// ============================================================================================

import "forge-std/Test.sol";
import {TapeAPIEscrow} from "../src/TapeAPIEscrow.sol";
import {
    BadSignature, InsufficientBalance, CooldownActive, WithdrawWindowClosed, NoPendingWithdraw, BadProvider,
    Expired, NothingToSettle, SessionShorteningNotSupported, SessionTooLong, AmountTooLarge, NotHolder, NotOwner,
    ZeroAddress, Reentrancy, TransferFailed, ZeroAmount, ContributionTooHigh
} from "../src/interfaces.sol";

// ---------- mocks (A2_ prefix; file is self-contained) ----------

contract A2_MockERC20 {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    function mint(address to, uint256 amt) external { balanceOf[to] += amt; }
    function approve(address s, uint256 amt) external returns (bool) { allowance[msg.sender][s] = amt; return true; }
    function transfer(address to, uint256 amt) external virtual returns (bool) { return _move(msg.sender, to, amt); }
    function transferFrom(address f, address to, uint256 amt) external virtual returns (bool) {
        allowance[f][msg.sender] -= amt;
        return _move(f, to, amt);
    }
    function _move(address f, address to, uint256 amt) internal virtual returns (bool) {
        balanceOf[f] -= amt; balanceOf[to] += amt; return true;
    }
}

/// @dev 1% fee-on-transfer (BEM is NOT such a token; this documents the assumption)
contract A2_FeeToken is A2_MockERC20 {
    function _move(address f, address to, uint256 amt) internal override returns (bool) {
        uint256 fee = amt / 100;
        balanceOf[f] -= amt; balanceOf[to] += amt - fee; balanceOf[address(0xdead)] += fee; return true;
    }
}

/// @dev USDT-style: transfer / transferFrom return nothing
contract A2_NoReturnToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    function mint(address to, uint256 amt) external { balanceOf[to] += amt; }
    function approve(address s, uint256 amt) external returns (bool) { allowance[msg.sender][s] = amt; return true; }
    function transfer(address to, uint256 amt) external { balanceOf[msg.sender] -= amt; balanceOf[to] += amt; }
    function transferFrom(address f, address to, uint256 amt) external { allowance[f][msg.sender] -= amt; balanceOf[f] -= amt; balanceOf[to] += amt; }
}

/// @dev returns false instead of reverting
contract A2_FalseToken {
    function transfer(address, uint256) external pure returns (bool) { return false; }
    function transferFrom(address, address, uint256) external pure returns (bool) { return false; }
}

interface IA2Hook { function onToken() external; }

/// @dev ERC-777-style: calls a global hook after every transfer / transferFrom (BEM has no hooks)
contract A2_HookToken is A2_MockERC20 {
    address public hook;
    function setHook(address h) external { hook = h; }
    function transfer(address to, uint256 amt) external override returns (bool) {
        _move(msg.sender, to, amt); if (hook != address(0)) IA2Hook(hook).onToken(); return true;
    }
    function transferFrom(address f, address to, uint256 amt) external override returns (bool) {
        allowance[f][msg.sender] -= amt; _move(f, to, amt); if (hook != address(0)) IA2Hook(hook).onToken(); return true;
    }
}

/// @dev A consumer contract that re-enters the escrow from inside the token hook and records what happened
contract A2_Reenterer is IA2Hook {
    TapeAPIEscrow public esc;
    address public provider;
    bool public armed;
    bytes4 public rFund; bytes4 public rWithdraw; bytes4 public rSettle; bool public reqOk; bool public fired;
    uint256 public cum; uint64 public exp; bytes public sig;
    constructor(TapeAPIEscrow e, address p) { esc = e; provider = p; }
    function setVoucher(uint256 c, uint64 x, bytes calldata s) external { cum = c; exp = x; sig = s; }
    function arm(bool a) external { armed = a; }
    function fund(uint256 amt) external { esc.fund(provider, amt); }
    function requestWithdraw(uint256 amt) external { esc.requestWithdraw(provider, amt); }
    function withdraw() external { esc.withdraw(provider); }
    function onToken() external {
        if (!armed) return;
        armed = false; fired = true;   // one attempt per outer call
        try esc.fund(provider, 1) { rFund = 0; } catch (bytes memory e) { rFund = bytes4(e); }
        try esc.withdraw(provider) { rWithdraw = 0; } catch (bytes memory e) { rWithdraw = bytes4(e); }
        try esc.settle(address(this), provider, cum, exp, sig) { rSettle = 0; } catch (bytes memory e) { rSettle = bytes4(e); }
        try esc.requestWithdraw(provider, 1) { reqOk = true; } catch { reqOk = false; }
    }
}

contract A2_MockERC721 {
    mapping(uint256 => address) public ownerOf;
    function mint(address to, uint256 id) external { ownerOf[id] = to; }
}

contract A2_FakeCircuits {
    address public puppet;
    constructor(address p) { puppet = p; }
    function ownerOf(uint256) external view returns (address) { return puppet; }
}

contract A2_MockHub {
    function accountOf(address circuits, uint256 tokenId) external pure returns (address) {
        return address(uint160(uint256(keccak256(abi.encode("container", circuits, tokenId)))));
    }
}

// ============================================================================================

contract Audit2_EscrowTest is Test {
    A2_MockERC20 bem;
    A2_MockERC721 nft;
    A2_MockHub hub;
    TapeAPIEscrow escrow;

    uint256 constant CONSUMER_PK = 0xC0FFEE;
    uint256 constant SESSION_PK = 0x5E55;
    uint256 constant ATTACKER_PK = 0xBAD;
    uint256 constant BEM = 1e8;                 // 8 decimals
    uint256 constant CHANNEL = 1_000 * BEM;
    uint64 constant COOLDOWN = 48 hours;
    uint64 constant WINDOW = 7 days;
    uint256 constant SECP_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;

    address consumer; address sessionKey; address attacker;
    address provider; address provider2;
    address treasury = address(0x7EA5);
    address stranger = address(0x57A2);

    function setUp() public {
        vm.warp(1_758_300_000);
        consumer = vm.addr(CONSUMER_PK); sessionKey = vm.addr(SESSION_PK); attacker = vm.addr(ATTACKER_PK);
        bem = new A2_MockERC20(); nft = new A2_MockERC721(); hub = new A2_MockHub();
        escrow = new TapeAPIEscrow(address(bem), address(hub), treasury);
        provider = hub.accountOf(address(nft), 1);
        provider2 = hub.accountOf(address(nft), 2);
        nft.mint(address(0xA11CE), 1);
        bem.mint(consumer, 1e12 * BEM);
        vm.startPrank(consumer);
        bem.approve(address(escrow), type(uint256).max);
        escrow.fund(provider, CHANNEL);
        vm.stopPrank();
        // These tests replay channel mechanics, where "paid in full" means the whole amount: the providers opt out of the
        // TAPI-22 §3.4 default contribution (1%) here. The contribution split, the default included, has its own tests in
        // TapeAPIEscrow.t.sol, and EscrowInvariant.t.sol starts every provider at the default.
        // 这些测试重放通道机制，"足额"指全额：此处让提供者关闭 TAPI-22 §3.4 的默认贡献（1%）。贡献拆分（含默认值）
        // 另有测试（TapeAPIEscrow.t.sol），EscrowInvariant.t.sol 让每个提供者从默认值开始。
        vm.prank(address(0xA11CE)); escrow.setContribution(address(nft), 1, 0);
    }

    // ----- helpers -----
    function _sign(uint256 pk, bytes32 d) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, d); return abi.encodePacked(r, s, v);
    }
    function _v(uint256 pk, address c, address p, uint256 cum, uint64 exp) internal view returns (bytes memory) {
        return _sign(pk, escrow.voucherDigest(c, p, cum, exp));
    }
    function _settleFull(uint256 cum) internal {
        uint256 claimed = escrow.claimedOf(consumer, provider);
        if (cum <= claimed) return;
        uint256 before = bem.balanceOf(provider);
        escrow.settle(consumer, provider, cum, type(uint64).max, _v(CONSUMER_PK, consumer, provider, cum, type(uint64).max));
        assertEq(bem.balanceOf(provider) - before, cum - claimed, "abiding provider must be paid in full");
    }

    // ============================================================================================
    //                       DECISION-escrow-v2.md claims, executed
    // ============================================================================================

    /// C-01 "structurally inexpressible": self-dealing moves only the consumer's own channel toward itself.
    function test_A2_claim_C01_selfDealTouchesOnlyOwnChannel() public {
        vm.prank(consumer); escrow.fund(consumer, 500 * BEM);           // channel toward self
        uint64 exp = uint64(block.timestamp + 1 hours);
        // voucher toward self for far more than the self-channel
        escrow.settle(consumer, consumer, 5_000 * BEM, exp, _v(CONSUMER_PK, consumer, consumer, 5_000 * BEM, exp));
        assertEq(escrow.channelOf(consumer, consumer), 0);
        assertEq(escrow.channelOf(consumer, provider), CHANNEL, "provider's channel untouched");
        assertEq(bem.balanceOf(address(escrow)), CHANNEL, "solvency identity holds");
        // and the provider still settles its own full channel afterwards
        escrow.settle(consumer, provider, CHANNEL, exp, _v(CONSUMER_PK, consumer, provider, CHANNEL, exp));
        assertEq(bem.balanceOf(provider), CHANNEL);
        assertEq(bem.balanceOf(address(escrow)), 0);
    }

    /// E-01/E-03: for EVERY instant inside the cooldown, settle pays in full and withdraw is impossible.
    function testFuzz_A2_claim_settleInsideCooldownAlwaysPaysInFull(uint64 dt, uint256 amt) public {
        dt = uint64(bound(dt, 0, COOLDOWN - 1));
        amt = bound(amt, 1, CHANNEL);
        uint64 t0 = uint64(block.timestamp);
        vm.prank(consumer); escrow.requestWithdraw(provider, CHANNEL);
        vm.warp(t0 + dt);
        vm.prank(consumer);
        vm.expectRevert(abi.encodeWithSelector(CooldownActive.selector, t0 + COOLDOWN));
        escrow.withdraw(provider);
        escrow.settle(consumer, provider, amt, type(uint64).max, _v(CONSUMER_PK, consumer, provider, amt, type(uint64).max));
        assertEq(bem.balanceOf(provider), amt);
        vm.warp(t0 + COOLDOWN);
        vm.prank(consumer);
        if (amt == CHANNEL) vm.expectRevert(InsufficientBalance.selector);   // settled to zero: nothing to take
        escrow.withdraw(provider);
        assertEq(escrow.channelOf(consumer, provider), 0);
        assertEq(bem.balanceOf(consumer), 1e12 * BEM - amt, "consumer recovers only the unsettled part");
    }

    /// The central v2 claim, as a randomised campaign: a provider that (a) serves only up to
    /// channel - armed (TAP-22 §3.2(4)) and (b) settles before every request matures is ALWAYS paid in full,
    /// no matter how the consumer interleaves request / cancel / re-request / fund / withdraw. Also asserts
    /// every successful withdraw is >= 48h after the latest request and <= the announced amount.
    uint256 camCum; uint64 camLastReqAt; uint256 camLastReqAmt;
    uint256 camWithdraws; uint256 camSettles; uint256 camCancels; uint256 camServed;

    function _campaign(uint256 seed, uint256 steps) internal {
        for (uint256 i = 0; i < steps; i++) {
            uint256 r = uint256(keccak256(abi.encode(seed, i)));
            uint256 op = r % 7; r >>= 8;
            uint256 ch = escrow.channelOf(consumer, provider);
            (uint256 pAmt, uint64 pAt) = escrow.pendingWithdraw(consumer, provider);
            if (op == 0) {
                if (ch == 0) continue;
                uint256 amt = r % ch + 1;
                vm.prank(consumer); escrow.requestWithdraw(provider, amt);
                camLastReqAt = uint64(block.timestamp); camLastReqAmt = amt;
            } else if (op == 1) {
                if (pAt == 0 || r % 4 != 0) continue;              // cancel is rarer than request
                vm.prank(consumer); escrow.cancelWithdraw(provider); camCancels++;
            } else if (op == 2) {
                uint256 dt = r % 40 hours + 1;
                // the abiding provider watches WithdrawRequested and settles before availableAt
                if (pAmt > 0 && block.timestamp < pAt + COOLDOWN && block.timestamp + dt >= pAt + COOLDOWN) _settleFull(camCum);
                vm.warp(block.timestamp + dt);
                _tryWithdraw();                                    // the consumer fires as soon as it can
            } else if (op == 3) {
                _tryWithdraw();
            } else if (op == 4) {
                vm.prank(consumer); escrow.fund(provider, r % (100 * BEM) + 1);
            } else if (op == 5) {
                uint256 armed = (pAmt > 0 && block.timestamp <= pAt + COOLDOWN + WINDOW) ? pAmt : 0;
                uint256 available = ch > armed ? ch - armed : 0;
                uint256 unsettled = camCum - escrow.claimedOf(consumer, provider);
                uint256 room = available > unsettled ? available - unsettled : 0;
                if (room > 0) { camCum += r % room + 1; camServed++; }
            } else {
                if (camCum > escrow.claimedOf(consumer, provider)) camSettles++;
                _settleFull(camCum);
            }
        }
    }

    function _tryWithdraw() internal {
        uint256 before = bem.balanceOf(consumer);
        vm.prank(consumer);
        try escrow.withdraw(provider) {
            camWithdraws++;
            uint256 got = bem.balanceOf(consumer) - before;
            assertGe(block.timestamp, camLastReqAt + COOLDOWN, "withdraw before 48h of the latest request");
            assertLe(block.timestamp, camLastReqAt + COOLDOWN + WINDOW, "withdraw after the window");
            assertLe(got, camLastReqAmt, "withdrew more than announced");
            assertGe(escrow.channelOf(consumer, provider), camCum - escrow.claimedOf(consumer, provider), "unsettled voucher left uncovered");
        } catch {}
    }

    function testFuzz_A2_claim_abidingProviderIsAlwaysPaidInFull(uint256 seed) public {
        _campaign(seed, 48);
        _settleFull(camCum);
        assertEq(bem.balanceOf(provider), camCum, "everything ever served was paid, exactly once");
    }

    /// Same campaign, 64 fixed seeds back to back, with proof that every path was actually exercised.
    function test_A2_claim_abidingProviderCampaign_coversEveryPath() public {
        for (uint256 s = 1; s <= 64; s++) _campaign(s, 48);
        _settleFull(camCum);
        assertEq(bem.balanceOf(provider), camCum, "everything ever served was paid, exactly once");
        assertGt(camWithdraws, 0, "no withdraw ever succeeded: campaign is vacuous");
        assertGt(camSettles, 0); assertGt(camCancels, 0); assertGt(camServed, 0);
        emit log_named_uint("withdraws", camWithdraws); emit log_named_uint("settles", camSettles);
        emit log_named_uint("cancels", camCancels); emit log_named_uint("serves", camServed);
    }

    /// Partial settlement: the same voucher is settled repeatedly and the provider is never paid twice for a delta.
    function test_A2_claim_partialSettlementNeverPaysTwice() public {
        uint64 exp = type(uint64).max;
        bytes memory sig = _v(CONSUMER_PK, consumer, provider, 2_500 * BEM, exp);
        escrow.settle(consumer, provider, 2_500 * BEM, exp, sig);
        assertEq(bem.balanceOf(provider), 1_000 * BEM); assertEq(escrow.claimedOf(consumer, provider), 1_000 * BEM);
        vm.expectRevert(InsufficientBalance.selector);
        escrow.settle(consumer, provider, 2_500 * BEM, exp, sig);            // channel empty: nothing more
        vm.prank(consumer); escrow.fund(provider, 700 * BEM);
        escrow.settle(consumer, provider, 2_500 * BEM, exp, sig);
        assertEq(bem.balanceOf(provider), 1_700 * BEM);
        vm.prank(consumer); escrow.fund(provider, 2_000 * BEM);
        escrow.settle(consumer, provider, 2_500 * BEM, exp, sig);
        assertEq(bem.balanceOf(provider), 2_500 * BEM, "total paid == cumulative, never more");
        assertEq(escrow.channelOf(consumer, provider), 1_200 * BEM);
        vm.expectRevert(NothingToSettle.selector);
        escrow.settle(consumer, provider, 2_500 * BEM, exp, sig);
        // an older, lower voucher is dead too
        bytes memory older = _v(CONSUMER_PK, consumer, provider, 2_000 * BEM, exp);
        vm.expectRevert(NothingToSettle.selector);
        escrow.settle(consumer, provider, 2_000 * BEM, exp, older);
    }

    /// Replay: a voucher is bound to (consumer, provider, escrow, chainId); ownership transfer changes nothing.
    function test_A2_claim_replayBoundToChannelEscrowChain() public {
        uint64 exp = uint64(block.timestamp + 1 hours);
        bytes memory sig = _v(CONSUMER_PK, consumer, provider, 100 * BEM, exp);
        vm.prank(consumer); escrow.fund(provider2, CHANNEL);
        // other channel of the same consumer
        vm.expectRevert(BadSignature.selector);
        escrow.settle(consumer, provider2, 100 * BEM, exp, sig);
        // another consumer's channel
        address c2 = vm.addr(0xC2); bem.mint(c2, CHANNEL);
        vm.startPrank(c2); bem.approve(address(escrow), CHANNEL); escrow.fund(provider, CHANNEL); vm.stopPrank();
        vm.expectRevert(BadSignature.selector);
        escrow.settle(c2, provider, 100 * BEM, exp, sig);
        // another escrow instance
        TapeAPIEscrow esc2 = new TapeAPIEscrow(address(bem), address(hub), treasury);
        vm.startPrank(consumer); bem.approve(address(esc2), CHANNEL); esc2.fund(provider, CHANNEL); vm.stopPrank();
        vm.expectRevert(BadSignature.selector);
        esc2.settle(consumer, provider, 100 * BEM, exp, sig);
        // ownership transfer: the digest does not depend on the owner
        escrow.transferOwnership(attacker); vm.prank(attacker); escrow.acceptOwnership();
        assertEq(escrow.owner(), attacker);
        escrow.settle(consumer, provider, 100 * BEM, exp, sig);
        assertEq(bem.balanceOf(provider), 100 * BEM);
        // chain fork: old signatures die, the domain is rebuilt
        bytes32 dsBefore = escrow.DOMAIN_SEPARATOR();
        vm.chainId(97);
        assertTrue(escrow.DOMAIN_SEPARATOR() != dsBefore);
        bytes memory sig2 = _v(CONSUMER_PK, consumer, provider, 200 * BEM, exp);
        vm.chainId(31337);
        vm.expectRevert(BadSignature.selector);
        escrow.settle(consumer, provider, 200 * BEM, exp, sig2);
    }

    /// Malleability & encoding: high-s, bad v and wrong length all recover to nothing.
    function test_A2_claim_signatureMalleabilityRejected() public {
        uint64 exp = uint64(block.timestamp + 1 hours);
        bytes32 d = escrow.voucherDigest(consumer, provider, 100 * BEM, exp);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(CONSUMER_PK, d);
        bytes32 sHigh = bytes32(SECP_N - uint256(s));
        uint8 vFlip = v == 27 ? 28 : 27;
        vm.expectRevert(BadSignature.selector);
        escrow.settle(consumer, provider, 100 * BEM, exp, abi.encodePacked(r, sHigh, vFlip));
        vm.expectRevert(BadSignature.selector);
        escrow.settle(consumer, provider, 100 * BEM, exp, abi.encodePacked(r, s, uint8(29)));
        vm.expectRevert(BadSignature.selector);
        escrow.settle(consumer, provider, 100 * BEM, exp, abi.encodePacked(r, s));       // 64 bytes
        // v in {0,1} is accepted (same signature, one spelling) -- settles exactly once
        escrow.settle(consumer, provider, 100 * BEM, exp, abi.encodePacked(r, s, v - 27));
        vm.expectRevert(NothingToSettle.selector);
        escrow.settle(consumer, provider, 100 * BEM, exp, abi.encodePacked(r, s, v));
    }

    /// Bounds: uint192 packing in _pending, cumulative = 2^256-1, request clamps to the announced amount.
    function test_A2_claim_typeBounds() public {
        address whale = vm.addr(0x11A1E);
        bem.mint(whale, 1 << 200);
        vm.startPrank(whale);
        bem.approve(address(escrow), type(uint256).max);
        escrow.fund(provider, 1 << 193);
        vm.expectRevert(AmountTooLarge.selector);
        escrow.requestWithdraw(provider, uint256(type(uint192).max) + 1);
        escrow.requestWithdraw(provider, type(uint192).max);
        (uint256 a, uint64 at) = escrow.pendingWithdraw(whale, provider);
        assertEq(a, type(uint192).max); assertEq(at, block.timestamp);
        vm.stopPrank();
        // cumulative at the type bound: pays the channel, claimed advances by what was paid, no overflow
        bytes memory sig = _v(CONSUMER_PK, consumer, provider, type(uint256).max, type(uint64).max);
        escrow.settle(consumer, provider, type(uint256).max, type(uint64).max, sig);
        assertEq(escrow.claimedOf(consumer, provider), CHANNEL);
        vm.prank(consumer); escrow.fund(provider, CHANNEL);
        escrow.settle(consumer, provider, type(uint256).max, type(uint64).max, sig);
        assertEq(escrow.claimedOf(consumer, provider), 2 * CHANNEL);
        assertEq(bem.balanceOf(provider), 2 * CHANNEL);
    }

    /// The announced amount is a hard cap on what leaves, even after top-ups (this is what makes the
    /// provider-side `channel - armed` rule sound).
    function test_A2_claim_withdrawNeverExceedsAnnouncedAmount() public {
        vm.startPrank(consumer);
        escrow.requestWithdraw(provider, 300 * BEM);
        escrow.fund(provider, 5_000 * BEM);
        vm.warp(block.timestamp + COOLDOWN);
        uint256 before = bem.balanceOf(consumer);
        escrow.withdraw(provider);
        assertEq(bem.balanceOf(consumer) - before, 300 * BEM);
        assertEq(escrow.channelOf(consumer, provider), 5_700 * BEM);
        (uint256 a,) = escrow.pendingWithdraw(consumer, provider); assertEq(a, 0, "request consumed");
        vm.expectRevert(NoPendingWithdraw.selector); escrow.withdraw(provider);
        vm.stopPrank();
    }

    /// No revoke, extend-only, per-channel, MAX_SESSION: the leaked-key blast radius is exactly one channel.
    function test_A2_claim_leakedSessionKeyBoundedByOneChannel() public {
        vm.startPrank(consumer);
        escrow.fund(provider2, CHANNEL);
        escrow.authorizeSession(provider, sessionKey, uint64(block.timestamp + 30 days));
        vm.expectRevert(abi.encodeWithSelector(SessionTooLong.selector, uint64(block.timestamp + 30 days)));
        escrow.authorizeSession(provider, sessionKey, uint64(block.timestamp + 30 days + 1));
        vm.expectRevert(SessionShorteningNotSupported.selector);
        escrow.authorizeSession(provider, sessionKey, uint64(block.timestamp + 1 days));
        vm.stopPrank();
        uint64 exp = type(uint64).max;
        // the thief signs an astronomic voucher: paid the channel, not a wei more
        escrow.settle(consumer, provider, type(uint256).max, exp, _v(SESSION_PK, consumer, provider, type(uint256).max, exp));
        assertEq(bem.balanceOf(provider), CHANNEL);
        // it cannot reach the other channel of the same consumer
        bytes memory other = _v(SESSION_PK, consumer, provider2, 1, exp);
        vm.expectRevert(BadSignature.selector);
        escrow.settle(consumer, provider2, 1, exp, other);
        // it cannot extend itself (authorizeSession is msg.sender-scoped)
        vm.prank(sessionKey); escrow.authorizeSession(provider, sessionKey, uint64(block.timestamp + 1 days));
        assertEq(escrow.sessionExpiry(consumer, provider, sessionKey), uint64(block.timestamp + 30 days), "consumer's grant untouched");
        assertEq(escrow.sessionExpiry(sessionKey, provider, sessionKey), uint64(block.timestamp + 1 days), "it only authorised itself on its own (empty) channel");
        // and after MAX_SESSION it is dead for anything funded later
        vm.warp(block.timestamp + 30 days + 1);
        vm.prank(consumer); escrow.fund(provider, CHANNEL);
        bytes memory late = _v(SESSION_PK, consumer, provider, type(uint256).max - 1, exp);
        vm.expectRevert(BadSignature.selector);
        escrow.settle(consumer, provider, type(uint256).max - 1, exp, late);
        assertEq(bem.balanceOf(provider), CHANNEL, "total drain == one channel's balance at the time");
    }

    /// Owner / treasury powers are bounded to treasury rotation; nobody can set another provider's bps.
    function test_A2_claim_ownerAndTreasuryPowersBounded() public {
        vm.prank(attacker); vm.expectRevert(NotOwner.selector); escrow.setTreasury(attacker);
        vm.expectRevert(ZeroAddress.selector); escrow.setTreasury(address(0));
        // the owner (this test contract) does not hold circuit 1
        vm.expectRevert(NotHolder.selector); escrow.setContribution(address(nft), 1, 2000);
        // a hostile owner rotates the treasury to itself: it redirects contributions only
        vm.prank(address(0xA11CE)); escrow.setContribution(address(nft), 1, 2000);
        escrow.setTreasury(attacker);
        uint64 exp = uint64(block.timestamp + 1 hours);
        escrow.settle(consumer, provider, 100 * BEM, exp, _v(CONSUMER_PK, consumer, provider, 100 * BEM, exp));
        assertEq(bem.balanceOf(attacker), 20 * BEM); assertEq(bem.balanceOf(provider), 80 * BEM);
        assertEq(escrow.channelOf(consumer, provider), 900 * BEM, "channels are untouchable by the owner");
        // the holder resets it; the owner cannot stop that
        vm.prank(address(0xA11CE)); escrow.setContribution(address(nft), 1, 0);
        escrow.settle(consumer, provider, 200 * BEM, exp, _v(CONSUMER_PK, consumer, provider, 200 * BEM, exp));
        assertEq(bem.balanceOf(attacker), 20 * BEM);
    }

    /// setContribution has no isCPU gate: a home-made ERC-721 can only set bps for its OWN derived container.
    function test_A2_claim_fakeCircuitsCannotSetAnotherProvidersBps() public {
        A2_FakeCircuits fake = new A2_FakeCircuits(attacker);
        vm.prank(attacker); escrow.setContribution(address(fake), 1, 2000);
        assertEq(escrow.contributionOf(provider), 0);   // as setUp left it / 保持 setUp 设定的值
        assertEq(escrow.contributionOf(hub.accountOf(address(fake), 1)), 2000);
        vm.prank(attacker); vm.expectRevert(NotHolder.selector); escrow.setContribution(address(nft), 1, 2000);
    }

    /// Third-party griefing with settle: an old voucher settled by a stranger, or a front-run of the provider's
    /// own settle, changes who pays gas and nothing else.
    function test_A2_claim_thirdPartySettleCannotHurtProvider() public {
        uint64 exp = uint64(block.timestamp + 1 hours);
        bytes memory old = _v(CONSUMER_PK, consumer, provider, 100 * BEM, exp);
        bytes memory latest = _v(CONSUMER_PK, consumer, provider, 800 * BEM, exp);
        vm.prank(stranger); escrow.settle(consumer, provider, 100 * BEM, exp, old);
        vm.prank(stranger); escrow.settle(consumer, provider, 800 * BEM, exp, latest);    // front-run
        vm.expectRevert(NothingToSettle.selector);
        escrow.settle(consumer, provider, 800 * BEM, exp, latest);                          // provider's own tx
        assertEq(bem.balanceOf(provider), 800 * BEM);
    }

    /// Reentrancy through token hooks: every guarded entry is closed from inside a transfer; the unguarded
    /// requestWithdraw is reachable but only starts a 48h clock.
    function test_A2_claim_reentrancyViaTokenHooksIsClosed() public {
        A2_HookToken tok = new A2_HookToken();
        TapeAPIEscrow esc = new TapeAPIEscrow(address(tok), address(hub), treasury);
        vm.prank(address(0xA11CE)); esc.setContribution(address(nft), 1, 0);   // as in setUp / 同 setUp
        A2_Reenterer re = new A2_Reenterer(esc, provider);
        tok.setHook(address(re));
        tok.mint(address(re), 10 * CHANNEL);
        vm.prank(address(re)); tok.approve(address(esc), type(uint256).max);
        // (1) inside fund's transferFrom
        re.arm(true); re.fund(CHANNEL);
        assertTrue(re.fired());
        assertEq(re.rFund(), Reentrancy.selector); assertEq(re.rWithdraw(), Reentrancy.selector); assertEq(re.rSettle(), Reentrancy.selector);
        assertTrue(re.reqOk(), "requestWithdraw is not guarded");
        (uint256 a, uint64 at) = esc.pendingWithdraw(address(re), provider);
        assertEq(a, 1); assertEq(at, block.timestamp);
        assertEq(esc.channelOf(address(re), provider), CHANNEL); assertEq(tok.balanceOf(address(esc)), CHANNEL);
        // (2) inside settle's transfer to the provider: the same voucher cannot be settled twice
        // (the reenterer is a contract; it "signs" nothing, so use consumer == signer path via a key it cannot have:
        //  instead settle a voucher the reenterer authorised a session key for)
        vm.prank(address(re)); esc.authorizeSession(provider, sessionKey, uint64(block.timestamp + 1 days));
        uint64 exp = uint64(block.timestamp + 1 hours);
        bytes memory sig = _sign(SESSION_PK, esc.voucherDigest(address(re), provider, 300 * BEM, exp));
        re.setVoucher(300 * BEM, exp, sig);
        re.arm(true);
        esc.settle(address(re), provider, 300 * BEM, exp, sig);
        assertEq(re.rSettle(), Reentrancy.selector); assertEq(re.rWithdraw(), Reentrancy.selector); assertEq(re.rFund(), Reentrancy.selector);
        assertEq(tok.balanceOf(provider), 300 * BEM, "paid once");
        assertEq(esc.claimedOf(address(re), provider), 300 * BEM);
        // (3) inside withdraw's transfer to the consumer
        vm.warp(block.timestamp + COOLDOWN);
        re.arm(true); re.withdraw();
        assertEq(re.rWithdraw(), Reentrancy.selector); assertEq(re.rSettle(), Reentrancy.selector);
        assertEq(tok.balanceOf(address(esc)), esc.channelOf(address(re), provider), "solvency identity holds after every hook");
    }

    /// cancelWithdraw can only relieve the provider; a re-request restarts the full 48h.
    function test_A2_claim_cancelThenRerequestRestartsClock() public {
        uint64 t0 = uint64(block.timestamp);
        vm.startPrank(consumer);
        escrow.requestWithdraw(provider, CHANNEL);
        vm.warp(t0 + COOLDOWN - 1);
        escrow.cancelWithdraw(provider);
        vm.warp(t0 + COOLDOWN);
        vm.expectRevert(NoPendingWithdraw.selector); escrow.withdraw(provider);
        escrow.requestWithdraw(provider, CHANNEL);
        vm.expectRevert(abi.encodeWithSelector(CooldownActive.selector, t0 + 2 * COOLDOWN)); escrow.withdraw(provider);
        vm.warp(t0 + 2 * COOLDOWN - 1);
        vm.expectRevert(abi.encodeWithSelector(CooldownActive.selector, t0 + 2 * COOLDOWN)); escrow.withdraw(provider);
        vm.stopPrank();
    }

    /// A lapsed request stays on-chain but is inert: it cannot be executed, only cancelled or replaced.
    function test_A2_claim_lapsedRequestIsInert() public {
        uint64 t0 = uint64(block.timestamp);
        vm.startPrank(consumer);
        escrow.requestWithdraw(provider, CHANNEL);
        vm.warp(t0 + COOLDOWN + WINDOW + 1);
        vm.expectRevert(WithdrawWindowClosed.selector); escrow.withdraw(provider);
        (uint256 a,) = escrow.pendingWithdraw(consumer, provider); assertEq(a, CHANNEL, "still recorded");
        escrow.cancelWithdraw(provider);
        (a,) = escrow.pendingWithdraw(consumer, provider); assertEq(a, 0);
        escrow.requestWithdraw(provider, CHANNEL);
        vm.expectRevert(abi.encodeWithSelector(CooldownActive.selector, uint64(block.timestamp) + COOLDOWN)); escrow.withdraw(provider);
        vm.stopPrank();
    }

    /// TAP-22 §3.3 / §3.3.1 / §3.4 MUST clauses not covered elsewhere in this file, executed one by one.
    function test_A2_must_conformanceChecklist() public {
        vm.startPrank(consumer);
        vm.expectRevert(ZeroAmount.selector);            escrow.fund(provider, 0);
        vm.expectRevert(BadProvider.selector);           escrow.fund(address(0), 1);
        vm.expectRevert(BadProvider.selector);           escrow.fund(address(escrow), 1);
        vm.expectRevert(ZeroAmount.selector);            escrow.requestWithdraw(provider, 0);
        vm.expectRevert(InsufficientBalance.selector);   escrow.requestWithdraw(provider, CHANNEL + 1);
        vm.expectRevert(NoPendingWithdraw.selector);     escrow.cancelWithdraw(provider);
        vm.expectRevert(NoPendingWithdraw.selector);     escrow.withdraw(provider);
        vm.expectRevert(ZeroAddress.selector);           escrow.authorizeSession(provider, address(0), uint64(block.timestamp + 1));
        vm.expectRevert(BadProvider.selector);           escrow.authorizeSession(address(escrow), sessionKey, uint64(block.timestamp + 1));
        vm.expectRevert(Expired.selector);               escrow.authorizeSession(provider, sessionKey, uint64(block.timestamp));
        vm.stopPrank();
        uint64 exp = uint64(block.timestamp + 1 hours);
        bytes memory toEscrow = _v(CONSUMER_PK, consumer, address(escrow), 1, exp);
        vm.expectRevert(BadProvider.selector);           escrow.settle(consumer, address(escrow), 1, exp, toEscrow);
        bytes memory toZero = _v(CONSUMER_PK, consumer, address(0), 1, exp);
        vm.expectRevert(BadProvider.selector);           escrow.settle(consumer, address(0), 1, exp, toZero);
        // inclusive expiry boundary, then Expired one second later
        bytes memory atExp = _v(CONSUMER_PK, consumer, provider, 1, exp);
        vm.warp(exp); escrow.settle(consumer, provider, 1, exp, atExp);
        bytes memory late = _v(CONSUMER_PK, consumer, provider, 2, exp);
        vm.warp(exp + 1); vm.expectRevert(Expired.selector); escrow.settle(consumer, provider, 2, exp, late);
        // §3.4: bps cap and holder-only, event emitted with the container as key
        vm.prank(address(0xA11CE)); vm.expectRevert(abi.encodeWithSelector(ContributionTooHigh.selector, uint16(2001))); escrow.setContribution(address(nft), 1, 2001);
        vm.prank(address(0xA11CE)); escrow.setContribution(address(nft), 1, 2000);
        assertEq(escrow.contributionOf(provider), 2000);
        // §3.1: `provider` MUST be the service container -- NOT enforced on-chain (A2-07): any EOA works
        vm.prank(consumer); escrow.fund(stranger, 1);
        assertEq(escrow.channelOf(consumer, stranger), 1);
    }

    // ============================================================================================
    //                                   FINDINGS (executed)
    // ============================================================================================

    /// A2-03 (Low, spec/doc): the 48h guarantee is per REQUEST and does not restart on `fund`. Money added to a
    /// channel while a request is alive is withdrawable up to the announced amount with ZERO additional delay.
    /// A provider that settled "everything it was owed before availableAt" (the NatSpec rule) and then served
    /// against the top-up is not paid. Only the §3.2(4) subtraction (channel - armed, NOT channel - claimed)
    /// protects it; that rule is therefore load-bearing, not advisory.
    function test_A2_finding03_topUpDuringLiveRequestIsWithdrawableInstantly() public {
        uint64 t0 = uint64(block.timestamp);
        vm.prank(consumer); escrow.requestWithdraw(provider, CHANNEL);
        // provider does exactly what the NatSpec asks: settles everything owed inside the cooldown
        uint64 exp = type(uint64).max;
        vm.warp(t0 + 1 hours);
        escrow.settle(consumer, provider, CHANNEL, exp, _v(CONSUMER_PK, consumer, provider, CHANNEL, exp));
        assertEq(escrow.channelOf(consumer, provider), 0);
        // consumer tops up 30s before availableAt; a provider reasoning "channel - claimed = 1000 available" serves 1000
        vm.warp(t0 + COOLDOWN - 30);
        vm.prank(consumer); escrow.fund(provider, CHANNEL);
        bytes memory v2 = _v(CONSUMER_PK, consumer, provider, 2 * CHANNEL, exp);
        // no new WithdrawRequested was ever emitted; 30s later the whole top-up leaves
        vm.warp(t0 + COOLDOWN);
        vm.prank(consumer); escrow.withdraw(provider);
        assertEq(escrow.channelOf(consumer, provider), 0);
        vm.expectRevert(InsufficientBalance.selector);
        escrow.settle(consumer, provider, 2 * CHANNEL, exp, v2);
        assertEq(bem.balanceOf(provider), CHANNEL, "second 1000 of service unpaid after a 30s window");
        // The reference server's rule would have refused: available = channel - armed = 1000 - 1000 = 0.
    }

    /// A2-03 variant executed literally: a request that survived a settled-to-zero channel (withdraw reverted
    /// InsufficientBalance and left it in place) lets a later top-up leave in the same block it arrives.
    function test_A2_finding03b_survivingRequestDrainsSameBlockTopUp() public {
        uint64 t0 = uint64(block.timestamp);
        uint64 exp = type(uint64).max;
        vm.prank(consumer); escrow.requestWithdraw(provider, CHANNEL);
        escrow.settle(consumer, provider, CHANNEL, exp, _v(CONSUMER_PK, consumer, provider, CHANNEL, exp));
        vm.warp(t0 + COOLDOWN + 3 days);
        vm.prank(consumer); vm.expectRevert(InsufficientBalance.selector); escrow.withdraw(provider);   // request survives
        vm.startPrank(consumer);
        escrow.fund(provider, 500 * BEM);
        uint256 before = bem.balanceOf(consumer);
        escrow.withdraw(provider);                                          // same block, no new 48h
        assertEq(bem.balanceOf(consumer) - before, 500 * BEM);
        vm.stopPrank();
    }

    /// A2-02 evidence (server, High): the contract enforces `expires` and the session bound at the instant of
    /// settlement, exactly as specified. Both bounds are chosen by the CONSUMER; the reference server accepts a
    /// voucher whose remaining life is 1 second and a session key that lapses 1 second later. This test shows the
    /// on-chain consequence: such vouchers are valid to the server and unsettleable one block later.
    function test_A2_finding02_consumerChosenDeadlinesAreUnsettleableOneBlockLater() public {
        // (a) voucher ttl = 1s, signed by the consumer directly
        uint64 exp = uint64(block.timestamp + 1);
        bytes memory sig = _v(CONSUMER_PK, consumer, provider, 100 * BEM, exp);
        vm.warp(block.timestamp + 3);                                       // one BSC block
        vm.expectRevert(Expired.selector);
        escrow.settle(consumer, provider, 100 * BEM, exp, sig);
        // (b) session authorised for 2 minutes; voucher signed 1s before it lapses with a generous ttl
        uint64 s = uint64(block.timestamp + 120);
        vm.prank(consumer); escrow.authorizeSession(provider, sessionKey, s);
        vm.warp(s - 1);
        uint64 exp2 = uint64(block.timestamp + 3600);
        bytes memory sig2 = _v(SESSION_PK, consumer, provider, 100 * BEM, exp2);
        // server rule at this instant: sessionExpiry(s) > now  AND expires > now  -> served
        assertGt(escrow.sessionExpiry(consumer, provider, sessionKey), block.timestamp);
        vm.warp(s + 1);
        vm.expectRevert(BadSignature.selector);
        escrow.settle(consumer, provider, 100 * BEM, exp2, sig2);
        assertEq(bem.balanceOf(provider), 0, "served, never paid");
    }

    /// A2-05 (Info): fee-on-transfer / deflationary tokens break the solvency identity at `fund`. BEM is not such a
    /// token (verified in round 1); recorded because the contract is token-generic in code but not in assumption.
    function test_A2_info05_feeOnTransferBreaksSolvency() public {
        A2_FeeToken tok = new A2_FeeToken();
        TapeAPIEscrow esc = new TapeAPIEscrow(address(tok), address(hub), treasury);
        tok.mint(consumer, CHANNEL);
        vm.startPrank(consumer);
        tok.approve(address(esc), CHANNEL);
        esc.fund(provider, CHANNEL);
        assertEq(esc.channelOf(consumer, provider), CHANNEL);
        assertEq(tok.balanceOf(address(esc)), CHANNEL - CHANNEL / 100, "credited more than received");
        esc.requestWithdraw(provider, CHANNEL);
        vm.warp(block.timestamp + COOLDOWN);
        vm.expectRevert();                                                  // underflow inside the token -> TransferFailed
        esc.withdraw(provider);
        vm.stopPrank();
    }

    /// ERC-20 return-value quirks: no-return tokens work, false-returning tokens and codeless "tokens" revert.
    function test_A2_claim_tokenReturnQuirks() public {
        A2_NoReturnToken nr = new A2_NoReturnToken();
        TapeAPIEscrow e1 = new TapeAPIEscrow(address(nr), address(hub), treasury);
        vm.prank(address(0xA11CE)); e1.setContribution(address(nft), 1, 0);   // as in setUp / 同 setUp
        nr.mint(consumer, CHANNEL);
        vm.startPrank(consumer); nr.approve(address(e1), CHANNEL); e1.fund(provider, CHANNEL); vm.stopPrank();
        assertEq(nr.balanceOf(address(e1)), CHANNEL);
        uint64 exp = uint64(block.timestamp + 1 hours);
        e1.settle(consumer, provider, 10 * BEM, exp, _sign(CONSUMER_PK, e1.voucherDigest(consumer, provider, 10 * BEM, exp)));
        assertEq(nr.balanceOf(provider), 10 * BEM);

        A2_FalseToken ft = new A2_FalseToken();
        TapeAPIEscrow e2 = new TapeAPIEscrow(address(ft), address(hub), treasury);
        vm.prank(consumer); vm.expectRevert(TransferFailed.selector); e2.fund(provider, 1);

        TapeAPIEscrow e3 = new TapeAPIEscrow(address(0xDEAD), address(hub), treasury);   // no code at the token address
        vm.prank(consumer); vm.expectRevert(TransferFailed.selector); e3.fund(provider, 1);
    }

    /// A2-06 (Info): `withdraw` arithmetic on uint64 timestamps panics only for requestedAt > 2^64 - 9 days
    /// (year ~5.8e11). Recorded for completeness; unreachable on any real chain.
    function test_A2_info06_uint64TimestampBound() public {
        vm.warp(uint256(type(uint64).max) - 8 days);
        vm.startPrank(consumer);
        escrow.requestWithdraw(provider, 1);
        vm.warp(uint256(type(uint64).max) - 6 days);
        vm.expectRevert(stdError.arithmeticError);
        escrow.withdraw(provider);
        vm.stopPrank();
    }
}
