// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Independent review R19 (internal audit notes, R19 section): the reviewer's property tests and finding repros, adapted to
// the fixes. F-1: a rotation pays the outgoing treasury first (the owner can no longer capture its accrual), and a
// failed payout neither reverts the rotation nor loses the accrual. F-2: setTreasury / the constructor refuse the
// escrow itself and its token. F-3: every non-standard token answer is TransferFailed(). F-5 / F-6: info pins.
// 独立审计 R19 的属性测试与发现复现，已按修复调整：F-1 换金库先付旧金库，付款失败既不回滚更换也不丢应收；
// F-2 拒绝把金库设为托管自身或代币；F-3 一切非标准的代币返回都是 TransferFailed()；F-5 / F-6 为信息项钉子。
import "forge-std/Test.sol";
import {TapeAPIEscrow} from "../src/TapeAPIEscrow.sol";
import {
    TransferFailed, ZeroAmount, InsufficientBalance, ZeroAddress, BadTreasury, Reentrancy, NotOwner, BadSignature
} from "../src/interfaces.sol";
import {
    Mal_ERC20, Mal_ERC721, Mal_Hub, Mal_NoReturnToken, Mal_BlocklistToken, Mal_RecipientHookToken,
    IMal_TokenReceiver
} from "./mocks/MaliciousTokens.sol";

/// @dev Token that returns an arbitrary-length / arbitrary-value return payload from transfer.
contract R19_WeirdReturnToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    bytes public ret;
    bool public reverts;   // revert with `ret` as the revert data instead of returning it
    function setRet(bytes calldata r) external { ret = r; }
    function setReverts(bool r) external { reverts = r; }
    function mint(address to, uint256 amt) external { balanceOf[to] += amt; }
    function approve(address s, uint256 amt) external returns (bool) { allowance[msg.sender][s] = amt; return true; }
    function transfer(address to, uint256 amt) external returns (bytes memory) {
        balanceOf[msg.sender] -= amt; balanceOf[to] += amt;
        bytes memory r = ret;
        if (reverts) assembly { revert(add(r, 0x20), mload(r)) }
        assembly { return(add(r, 0x20), mload(r)) }
    }
    function transferFrom(address f, address to, uint256 amt) external returns (bytes memory) {
        allowance[f][msg.sender] -= amt; balanceOf[f] -= amt; balanceOf[to] += amt;
        bytes memory r = ret;
        if (reverts) assembly { revert(add(r, 0x20), mload(r)) }
        assembly { return(add(r, 0x20), mload(r)) }
    }
}

/// @dev An owner contract that rotates the treasury to itself and claims, atomically (the F-1 attack shape).
contract R19_GreedyOwner {
    function grab(TapeAPIEscrow e) external returns (uint256) {
        e.setTreasury(address(this));
        return e.claimTreasury();
    }
}

/// @dev A treasury contract that can also be the escrow's owner: it executes arbitrary calls, can refuse the token,
///      and on receipt re-enters the escrow with a stored call, recording the result.
///      可兼任 owner 的金库合约：可执行任意调用、可拒收代币，收款时用预存的调用重入托管并记录结果。
contract R19_ReenteringTreasury is IMal_TokenReceiver {
    TapeAPIEscrow public escrow;
    bool public reject;
    bytes public reenterCall;
    bool public reentered;
    bool public lastOk;
    bytes public lastErr;
    uint256 public received;
    function setEscrow(TapeAPIEscrow e) external { escrow = e; }
    function setReject(bool r) external { reject = r; }
    function setReenter(bytes calldata data) external { reenterCall = data; }
    function exec(address target, bytes calldata data) external returns (bytes memory) {
        (bool ok, bytes memory ret) = target.call(data);
        if (!ok) assembly { revert(add(ret, 0x20), mload(ret)) }
        return ret;
    }
    function onTokenReceived(address, uint256 amount) external {
        require(!reject, "treasury rejects");
        received += amount;
        if (reenterCall.length != 0) {
            (bool ok, bytes memory ret) = address(escrow).call(reenterCall);
            reentered = true; lastOk = ok; lastErr = ret;
        }
    }
}

/// @dev A hub that derives one chosen provider address for every circuit (so the provider can be a contract that is
///      also the escrow's owner). / 对任何容器都推导出同一个指定提供者的 hub（提供者可以是同时兼任 owner 的合约）。
contract R19_FixedHub {
    address public immutable provider;
    constructor(address provider_) { provider = provider_; }
    function accountOf(address, uint256) external view returns (address) { return provider; }
}

interface IAnyToken {
    function balanceOf(address) external view returns (uint256);
    function mint(address, uint256) external;
}

contract R19_ReviewTest is Test {
    Mal_ERC721 nft;
    Mal_Hub hub;
    address treasury = address(0x7EA5);
    address holder = address(0xA11CE);
    uint256[2] cpk = [uint256(0xC0FFEE1), 0xC0FFEE2];
    address[2] consumers;
    address[2] providers;
    uint256 constant UNIT = 1e18;

    // ghost
    mapping(address => mapping(address => uint256)) fundedOf;
    mapping(address => mapping(address => uint256)) withdrawnOf;
    mapping(address => mapping(address => uint256)) lastClaimed;
    uint256 donated;
    uint256 accruedGhost;
    uint256 claimedGhost;

    function setUp() public {
        vm.warp(1_758_300_000);
        nft = new Mal_ERC721(); hub = new Mal_Hub();
        nft.mint(holder, 1); nft.mint(holder, 2);
        consumers[0] = vm.addr(cpk[0]); consumers[1] = vm.addr(cpk[1]);
        providers[0] = hub.accountOf(address(nft), 1);
        providers[1] = hub.accountOf(address(nft), 2);
    }

    function _sig(TapeAPIEscrow e, uint256 pk, address c, address p, uint256 cum, uint64 exp) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, e.voucherDigest(c, p, cum, exp));
        return abi.encodePacked(r, s, v);
    }

    function _sumCh(TapeAPIEscrow e) internal view returns (uint256 s) {
        for (uint256 i; i < 2; i++) for (uint256 j; j < 2; j++) s += e.channelOf(consumers[i], providers[j]);
    }

    function _checkInvariants(TapeAPIEscrow e, address tok) internal view {
        uint256 bal = IAnyToken(tok).balanceOf(address(e));
        uint256 owed = _sumCh(e) + e.treasuryAccrued();
        assertGe(bal, owed, "solvency >=");
        assertEq(bal, owed + donated, "ghost-exact solvency");
        assertEq(accruedGhost, e.treasuryAccrued() + claimedGhost, "contribution conservation");
        for (uint256 i; i < 2; i++) for (uint256 j; j < 2; j++) {
            address c = consumers[i]; address p = providers[j];
            assertEq(fundedOf[c][p], e.channelOf(c, p) + e.claimedOf(c, p) + withdrawnOf[c][p], "per-channel conservation");
            assertGe(e.claimedOf(c, p), lastClaimed[c][p], "claimed monotone");
        }
    }

    /// Random op sequence driven by fuzz bytes. `noReturn` selects the USDT-style token.
    function _runSequence(bytes memory ops, bool noReturn) internal {
        address tok = noReturn ? address(new Mal_NoReturnToken()) : address(new Mal_ERC20());
        TapeAPIEscrow e = new TapeAPIEscrow(tok, address(hub), treasury);
        for (uint256 i; i < 2; i++) {
            vm.prank(consumers[i]);
            if (noReturn) Mal_NoReturnToken(tok).approve(address(e), type(uint256).max);
            else Mal_ERC20(tok).approve(address(e), type(uint256).max);
        }
        uint256 n = ops.length / 4;
        for (uint256 k; k < n && k < 64; k++) {
            _step(e, tok, noReturn, uint8(ops[4 * k]) % 9, uint8(ops[4 * k + 1]) % 2, uint8(ops[4 * k + 2]) % 2, uint8(ops[4 * k + 3]));
            for (uint256 i; i < 2; i++) for (uint256 j; j < 2; j++) lastClaimed[consumers[i]][providers[j]] = e.claimedOf(consumers[i], providers[j]);
            _checkInvariants(e, tok);
        }
    }

    function _step(TapeAPIEscrow e, address tok, bool noReturn, uint8 op, uint256 ci, uint256 pi, uint256 x) internal {
        address c = consumers[ci]; address p = providers[pi];
        if (op == 0) _opFund(e, tok, c, p, x);
        else if (op == 1) _opSettle(e, tok, ci, pi, x);
        else if (op == 2) { uint256 ch = e.channelOf(c, p); if (ch == 0) return; vm.prank(c); e.requestWithdraw(p, bound(x, 1, ch)); }
        else if (op == 3) _opWithdraw(e, tok, c, p);
        else if (op == 4) _opClaim(e, tok, x);
        else if (op == 5) _opRotate(e, tok, address(uint160(0x7EA0 + x % 4 + 1)));
        else if (op == 6) _opDonate(e, tok, noReturn, x + 1);
        else if (op == 7) vm.warp(block.timestamp + (x + 1) * 1 hours);
        else { vm.prank(holder); e.setContribution(address(nft), pi + 1, uint16(bound(x, 0, 2000))); }
    }

    function _opFund(TapeAPIEscrow e, address tok, address c, address p, uint256 x) internal {
        uint256 amt = (x + 1) * UNIT;
        IAnyToken(tok).mint(c, amt);
        vm.prank(c); e.fund(p, amt);
        fundedOf[c][p] += amt;
    }

    function _opSettle(TapeAPIEscrow e, address tok, uint256 ci, uint256 pi, uint256 x) internal {
        address c = consumers[ci]; address p = providers[pi];
        uint256 ch = e.channelOf(c, p);
        if (ch == 0) return;
        uint256 cl = e.claimedOf(c, p);
        uint256 delta = (x + 1) * UNIT / 7 + 1;   // may exceed channel: partial settlement
        uint256 pay = delta > ch ? ch : delta;
        uint256 contribution = pay * e.contributionOf(p) / 10_000;
        uint256 pBefore = IAnyToken(tok).balanceOf(p);
        bytes memory s = _sig(e, cpk[ci], c, p, cl + delta, uint64(block.timestamp + 1 hours));
        e.settle(c, p, cl + delta, uint64(block.timestamp + 1 hours), s);
        assertEq(IAnyToken(tok).balanceOf(p) - pBefore, pay - contribution, "provider share");
        assertEq(e.claimedOf(c, p), cl + pay, "claimed += pay");
        accruedGhost += contribution;
    }

    function _opWithdraw(TapeAPIEscrow e, address tok, address c, address p) internal {
        (uint256 amt, uint64 at) = e.pendingWithdraw(c, p);
        if (amt == 0) return;
        if (block.timestamp < at + 48 hours || block.timestamp > at + 48 hours + 7 days) return;
        uint256 ch = e.channelOf(c, p);
        uint256 take = amt > ch ? ch : amt;
        if (take == 0) return;
        uint256 before = IAnyToken(tok).balanceOf(c);
        vm.prank(c); e.withdraw(p);
        assertEq(IAnyToken(tok).balanceOf(c) - before, take, "withdraw pays min");
        withdrawnOf[c][p] += take;
    }

    function _opClaim(TapeAPIEscrow e, address tok, uint256 x) internal {
        uint256 a = e.treasuryAccrued();
        if (a == 0) { vm.expectRevert(ZeroAmount.selector); e.claimTreasury(); return; }
        address t = e.treasury();
        uint256 tb = IAnyToken(tok).balanceOf(t);
        vm.prank(address(uint160(x + 1)));
        e.claimTreasury();
        assertEq(IAnyToken(tok).balanceOf(t) - tb, a, "claim pays treasury");
        claimedGhost += a;
    }

    /// F-1: rotating away pays the whole accrual to the outgoing treasury (all four targets receive).
    function _opRotate(TapeAPIEscrow e, address tok, address t) internal {
        address old = e.treasury();
        uint256 a = e.treasuryAccrued();
        uint256 ob = IAnyToken(tok).balanceOf(old);
        e.setTreasury(t);
        assertEq(e.treasury(), t);
        if (t == old) { assertEq(e.treasuryAccrued(), a, "same address: no payout"); return; }
        assertEq(e.treasuryAccrued(), 0, "rotation pays the outgoing treasury");
        assertEq(IAnyToken(tok).balanceOf(old) - ob, a, "outgoing treasury receives the accrual");
        claimedGhost += a;
    }

    function _opDonate(TapeAPIEscrow e, address tok, bool noReturn, uint256 amt) internal {
        IAnyToken(tok).mint(address(this), amt);
        if (noReturn) Mal_NoReturnToken(tok).transfer(address(e), amt);
        else Mal_ERC20(tok).transfer(address(e), amt);
        donated += amt;
    }

    function testFuzz_R19_randomSequence_boolToken(bytes memory ops) public { _runSequence(ops, false); }
    function testFuzz_R19_randomSequence_noReturnToken(bytes memory ops) public { _runSequence(ops, true); }

    /// Treasury-side calls (claimTreasury, setTreasury) never touch any channel / claim / request / session, and move
    /// exactly the accrual (setTreasury: to the outgoing treasury, unless the target is the current one).
    function testFuzz_R19_treasuryCallsTouchNoChannel(bytes memory ops, address newT) public {
        Mal_ERC20 tok = new Mal_ERC20();
        TapeAPIEscrow e = new TapeAPIEscrow(address(tok), address(hub), treasury);
        vm.assume(newT != address(0) && newT != address(e) && newT != address(tok));
        for (uint256 i; i < 2; i++) { vm.prank(consumers[i]); tok.approve(address(e), type(uint256).max); }
        // build some state
        for (uint256 k; k + 1 < ops.length && k < 40; k += 2) {
            _buildState(e, tok, uint8(ops[k]) % 2, uint8(ops[k + 1]) % 2, uint8(ops[k]));
        }
        bytes32 snap = _snapshot(e);
        uint256 bal = tok.balanceOf(address(e));
        uint256 acc = e.treasuryAccrued();
        uint256 oldBal = tok.balanceOf(treasury);
        e.setTreasury(newT);
        assertEq(_snapshot(e), snap, "setTreasury touched channel state");
        if (newT != treasury) {
            assertEq(tok.balanceOf(address(e)), bal - acc, "setTreasury moved exactly the accrual");
            assertEq(tok.balanceOf(treasury) - oldBal, acc, "to the outgoing treasury");
            assertEq(e.treasuryAccrued(), 0);
            acc = 0;
        } else {
            assertEq(tok.balanceOf(address(e)), bal, "same treasury: nothing moved");
            assertEq(e.treasuryAccrued(), acc);
        }
        if (acc > 0) {
            uint256 got = e.claimTreasury();
            assertEq(got, acc);
            assertEq(tok.balanceOf(address(e)), bal - acc, "claim removed exactly the accrual");
        }
        assertEq(_snapshot(e), snap, "claimTreasury touched channel state");
    }

    function _buildState(TapeAPIEscrow e, Mal_ERC20 tok, uint256 ci, uint256 pi, uint256 x) internal {
        address c = consumers[ci]; address p = providers[pi];
        uint256 amt = (x + 1) * UNIT;
        tok.mint(c, amt); vm.prank(c); e.fund(p, amt);
        uint256 cum = e.claimedOf(c, p) + amt / 3 + 1;
        bytes memory s = _sig(e, cpk[ci], c, p, cum, uint64(block.timestamp + 1 hours));
        e.settle(c, p, cum, uint64(block.timestamp + 1 hours), s);
        vm.prank(c); e.requestWithdraw(p, 1);
        vm.prank(c); e.authorizeSession(p, address(0xBEEF), uint64(block.timestamp + 1 days));
    }

    function _snapshot(TapeAPIEscrow e) internal view returns (bytes32) {
        bytes memory b;
        for (uint256 i; i < 2; i++) for (uint256 j; j < 2; j++) {
            address c = consumers[i]; address p = providers[j];
            (uint256 a, uint64 at) = e.pendingWithdraw(c, p);
            b = bytes.concat(b, abi.encode(e.channelOf(c, p), e.claimedOf(c, p), a, at, e.sessionExpiry(c, p, address(0xBEEF)), e.contributionOf(p)));
        }
        return keccak256(b);
    }

    // ------------------------------------------------------------------ finding repros ----

    event TreasuryChanged(address indexed oldTreasury, address indexed newTreasury);
    event TreasuryClaimed(address indexed treasury, uint256 amount);

    /// Fresh escrow over a plain token, one channel funded with 1000 units and settled in full at 20%: 200 accrued.
    function _accrued200(address owner_) internal returns (Mal_ERC20 tok, TapeAPIEscrow e) {
        tok = new Mal_ERC20();
        vm.prank(owner_);
        e = new TapeAPIEscrow(address(tok), address(hub), treasury);
        _fundAndSettle(e, address(tok), 1000 * UNIT, 2000);
    }

    function _fundAndSettle(TapeAPIEscrow e, address tok, uint256 amt, uint16 bps) internal {
        address c = consumers[0]; address p = providers[0];
        IAnyToken(tok).mint(c, amt);
        vm.prank(c); Mal_ERC20(tok).approve(address(e), type(uint256).max);
        vm.prank(c); e.fund(p, amt);
        vm.prank(holder); e.setContribution(address(nft), 1, bps);
        uint64 exp = uint64(block.timestamp + 1 hours);
        uint256 cum = e.claimedOf(c, p) + amt;
        e.settle(c, p, cum, exp, _sig(e, cpk[0], c, p, cum, exp));
    }

    // ---- F-1: rotation pays the outgoing treasury first ----

    /// F-1 (was the repro test_R19_ownerCapturesUnclaimedAccrual_atomically, assertions inverted): an owner that is
    /// not the treasury rotates to itself and claims in one transaction. The rotation pays the 200 to the treasury
    /// that earned them; the owner's claim finds nothing (ZeroAmount reverts the whole grab, so it gains nothing).
    /// F-1（原复现测试，断言取反）：非金库的 owner 在一笔交易里把金库换成自己再领取。更换先把 200 付给挣得它的金库，
    /// owner 的领取一无所获（ZeroAmount 使整个操作回滚）。
    function test_R19_ownerCannotCaptureUnclaimedAccrual_atomically() public {
        R19_GreedyOwner owner = new R19_GreedyOwner();
        (Mal_ERC20 tok, TapeAPIEscrow e) = _accrued200(address(owner));
        assertEq(e.treasuryAccrued(), 200 * UNIT);
        vm.expectRevert(ZeroAmount.selector);
        owner.grab(e);                                          // setTreasury(owner) pays the old treasury; claim is empty
        assertEq(tok.balanceOf(address(owner)), 0, "the owner gets nothing");
        // without the atomic claim the rotation itself succeeds -- and the treasury that earned the 200 has them
        vm.prank(address(owner)); e.setTreasury(address(owner));
        assertEq(tok.balanceOf(treasury), 200 * UNIT, "the original treasury is paid");
        assertEq(tok.balanceOf(address(owner)), 0, "the owner still has nothing");
        assertEq(e.treasuryAccrued(), 0);
        assertEq(e.channelOf(consumers[0], providers[0]), 0); assertEq(tok.balanceOf(providers[0]), 800 * UNIT);
        assertEq(tok.balanceOf(address(e)), 0);
    }

    /// F-1 events: TreasuryClaimed(old, amount) THEN TreasuryChanged(old, new), exact arguments; the new treasury
    /// receives nothing of the old accrual. / 事件顺序与参数精确；新金库拿不到旧应收。
    function test_R19_rotation_paysOldTreasury_eventsInOrder() public {
        (Mal_ERC20 tok, TapeAPIEscrow e) = _accrued200(address(this));
        address t2 = address(0x7EA6);
        vm.expectEmit(true, false, false, true, address(e));
        emit TreasuryClaimed(treasury, 200 * UNIT);
        vm.expectEmit(true, true, false, true, address(e));
        emit TreasuryChanged(treasury, t2);
        e.setTreasury(t2);
        assertEq(tok.balanceOf(treasury), 200 * UNIT);
        assertEq(tok.balanceOf(t2), 0, "the new treasury gets none of the old accrual");
        assertEq(e.treasury(), t2);
        assertEq(e.treasuryAccrued(), 0);
    }

    /// F-1: the outgoing treasury is frozen (blocklist). The rotation succeeds, emits only TreasuryChanged, keeps the
    /// accrual, and the new treasury claims it -- the "frozen treasury is recoverable" property is kept.
    /// F-1：旧金库被冻结。更换成功、只发 TreasuryChanged、保留应收，新金库领取——保留"冻结可恢复"的性质。
    function test_R19_rotation_frozenOldTreasury_succeeds_accrualFollowsRole() public {
        Mal_BlocklistToken tok = new Mal_BlocklistToken();
        TapeAPIEscrow e = new TapeAPIEscrow(address(tok), address(hub), treasury);
        _fundAndSettle(e, address(tok), 1000 * UNIT, 2000);
        tok.setBlocked(treasury, true);
        address t2 = address(0x7EA6);
        vm.recordLogs();
        e.setTreasury(t2);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1, "no TreasuryClaimed for a failed payout");
        assertEq(logs[0].topics[0], TreasuryChanged.selector);
        assertEq(logs[0].topics[1], bytes32(uint256(uint160(treasury))));
        assertEq(logs[0].topics[2], bytes32(uint256(uint160(t2))));
        assertEq(e.treasury(), t2);
        assertEq(e.treasuryAccrued(), 200 * UNIT, "the accrual stays with the role");
        assertEq(tok.balanceOf(treasury), 0);
        vm.expectEmit(true, false, false, true, address(e));
        emit TreasuryClaimed(t2, 200 * UNIT);
        e.claimTreasury();
        assertEq(tok.balanceOf(t2), 200 * UNIT, "the new treasury recovers it");
        assertEq(tok.balanceOf(address(e)), 0);
    }

    /// F-1: the outgoing treasury is a contract that rejects the token (receiver hook reverts). Same outcome.
    function test_R19_rotation_rejectingOldTreasury_succeeds_accrualFollowsRole() public {
        Mal_RecipientHookToken tok = new Mal_RecipientHookToken();
        R19_ReenteringTreasury rt = new R19_ReenteringTreasury();
        TapeAPIEscrow e = new TapeAPIEscrow(address(tok), address(hub), address(rt));
        rt.setEscrow(e);
        tok.setHooked(address(rt), true);
        rt.setReject(true);
        _fundAndSettle(e, address(tok), 1000 * UNIT, 2000);
        address t2 = address(0x7EA6);
        e.setTreasury(t2);
        assertEq(e.treasury(), t2);
        assertEq(e.treasuryAccrued(), 200 * UNIT);
        assertEq(rt.received(), 0);
        e.claimTreasury();
        assertEq(tok.balanceOf(t2), 200 * UNIT);
    }

    /// F-1 re-entrancy: the outgoing treasury, paid inside setTreasury, re-enters claimTreasury, settle, and (being
    /// the owner) setTreasury; each gets exactly Reentrancy(). It is paid once, and the rotation lands where asked.
    /// F-1 重入：在 setTreasury 中收款的旧金库重入 claimTreasury、settle，以及（作为 owner）setTreasury，均得到
    /// Reentrancy()；只被付一次，更换落在所要求的地址。
    function test_R19_rotation_reenteringOldTreasury_isGuarded() public {
        Mal_RecipientHookToken tok = new Mal_RecipientHookToken();
        R19_ReenteringTreasury rt = new R19_ReenteringTreasury();
        vm.prank(address(rt));
        TapeAPIEscrow e = new TapeAPIEscrow(address(tok), address(hub), address(rt));   // rt is owner AND treasury
        rt.setEscrow(e);
        tok.setHooked(address(rt), true);
        address c = consumers[0]; address p = providers[0];
        address[3] memory targets = [address(0x7EA1), address(0x7EA2), address(0x7EA3)];
        uint256 paid;
        for (uint256 i; i < 3; i++) {
            if (i > 0) { vm.prank(address(rt)); e.setTreasury(address(rt)); }   // nothing accrued: no payout
            _fundAndSettle(e, address(tok), 1000 * UNIT, 2000);                 // 200 accrued
            tok.mint(c, 100 * UNIT); vm.prank(c); e.fund(p, 100 * UNIT);        // a re-entered settle WOULD pay
            uint256 a = e.treasuryAccrued();
            uint256 claimedBefore = e.claimedOf(c, p);
            uint64 exp = uint64(block.timestamp + 1 hours);
            bytes memory reenter;
            if (i == 0) reenter = abi.encodeCall(TapeAPIEscrow.claimTreasury, ());
            else if (i == 1) {
                bytes memory sig = _sig(e, cpk[0], c, p, claimedBefore + 50 * UNIT, exp);
                reenter = abi.encodeCall(TapeAPIEscrow.settle, (c, p, claimedBefore + 50 * UNIT, exp, sig));
            } else reenter = abi.encodeCall(TapeAPIEscrow.setTreasury, (address(0xBAD)));
            rt.setReenter(reenter);
            vm.prank(address(rt));
            e.setTreasury(targets[i]);
            assertTrue(rt.reentered(), "the callback ran");
            assertFalse(rt.lastOk(), "re-entry refused");
            assertEq(bytes4(rt.lastErr()), Reentrancy.selector, "exactly Reentrancy()");
            paid += a;
            assertEq(rt.received(), paid, "the outgoing treasury is paid exactly once per rotation");
            assertEq(e.treasuryAccrued(), 0);
            assertEq(e.treasury(), targets[i], "the rotation lands where the outer call asked");
            assertEq(e.claimedOf(c, p), claimedBefore, "no settle inside the rotation");
            rt.setReenter("");
        }
    }

    /// F-1 lock check, independent of the nested-rotation case above: an owner that is also a PROVIDER (a hook token pays
    /// it inside `settle`, `_lock == 2`) tries to swap the treasury from the callback. `setTreasury` must refuse with
    /// exactly `Reentrancy()`: without its `_lock != 1` check the swap would land mid-settlement. The settlement itself
    /// still completes and the provider is paid.
    /// F-1 锁检查，独立于上面的嵌套更换用例：兼任 provider 的 owner 在 `settle` 内收款（钩子代币，`_lock == 2`）时
    /// 从回调里换金库；`setTreasury` 必须精确回滚 `Reentrancy()`。去掉 `_lock != 1` 检查，更换会在结算中途生效。
    /// 结算本身照常完成，provider 照常收款。
    function test_R19_setTreasury_inSettleCallback_ownerIsProvider_isReentrancy() public {
        Mal_RecipientHookToken tok = new Mal_RecipientHookToken();
        R19_ReenteringTreasury op = new R19_ReenteringTreasury();            // owner AND provider
        R19_FixedHub fixedHub = new R19_FixedHub(address(op));
        vm.prank(address(op));
        TapeAPIEscrow e = new TapeAPIEscrow(address(tok), address(fixedHub), treasury);
        op.setEscrow(e);
        tok.setHooked(address(op), true);
        address c = consumers[0];
        tok.mint(c, 1000 * UNIT);
        vm.prank(c); tok.approve(address(e), type(uint256).max);
        vm.prank(c); e.fund(address(op), 1000 * UNIT);
        op.setReenter(abi.encodeCall(TapeAPIEscrow.setTreasury, (address(0xBAD))));
        uint64 exp = uint64(block.timestamp + 1 hours);
        bytes memory sig = _sig(e, cpk[0], c, address(op), 500 * UNIT, exp);
        e.settle(c, address(op), 500 * UNIT, exp, sig);
        assertTrue(op.reentered(), "the provider hook ran inside settle");
        assertFalse(op.lastOk(), "the swap was refused");
        assertEq(bytes4(op.lastErr()), Reentrancy.selector, "exactly Reentrancy()");
        assertEq(e.treasury(), treasury, "the treasury did not change");
        assertGt(e.treasuryAccrued(), 0);
        assertEq(op.received(), 500 * UNIT - e.treasuryAccrued(), "the provider was paid its share");
        // and once settle is over the same owner can rotate / settle 结束后同一 owner 可以更换
        op.setReenter("");
        op.exec(address(e), abi.encodeCall(TapeAPIEscrow.setTreasury, (address(0x7EA6))));
        assertEq(e.treasury(), address(0x7EA6));
    }

    /// F-1: rotating to the current treasury, with something accrued, does nothing: no payout, no event.
    function test_R19_rotation_sameAddress_isNoOp() public {
        (Mal_ERC20 tok, TapeAPIEscrow e) = _accrued200(address(this));
        vm.recordLogs();
        e.setTreasury(treasury);
        assertEq(vm.getRecordedLogs().length, 0, "no event");
        assertEq(e.treasuryAccrued(), 200 * UNIT, "no payout");
        assertEq(tok.balanceOf(treasury), 0);
        assertEq(e.treasury(), treasury);
    }

    /// F-1: rotating with nothing accrued makes no token call and emits only TreasuryChanged.
    function test_R19_rotation_zeroAccrual_noTokenCall() public {
        Mal_ERC20 tok = new Mal_ERC20();
        TapeAPIEscrow e = new TapeAPIEscrow(address(tok), address(hub), treasury);
        address t2 = address(0x7EA6);
        vm.expectCall(address(tok), abi.encodeWithSelector(Mal_ERC20.transfer.selector), 0);
        vm.recordLogs();
        e.setTreasury(t2);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1);
        assertEq(logs[0].topics[0], TreasuryChanged.selector);
        assertEq(e.treasury(), t2);
    }

    /// F-1 gas griefing: whatever gas limit the owner picks, a rotation that SUCCEEDS has paid the outgoing treasury
    /// (the 63/64 rule leaves the rest of setTreasury far too little gas if the transfer itself was starved).
    /// F-1 gas 操纵：owner 无论选什么 gas 上限，只要更换成功，旧金库就已被付清。
    function testFuzz_R19_rotation_gasLimit_neverSkipsPayout(uint256 g) public {
        (Mal_ERC20 tok, TapeAPIEscrow e) = _accrued200(address(this));
        g = bound(g, 5_000, 400_000);
        (bool ok,) = address(e).call{gas: g}(abi.encodeCall(TapeAPIEscrow.setTreasury, (address(0x7EA6))));
        if (ok) {
            assertEq(e.treasuryAccrued(), 0, "a successful rotation always paid the outgoing treasury");
            assertEq(tok.balanceOf(treasury), 200 * UNIT);
        } else {
            assertEq(e.treasury(), treasury, "a failed rotation changed nothing");
            assertEq(e.treasuryAccrued(), 200 * UNIT);
        }
    }

    /// The same property swept deterministically over every gas limit from 20k to 400k in 250-gas steps, plus a
    /// check that the sweep is not vacuous (both outcomes occur). / 确定性扫描 20k–400k，并确认两种结果都出现过。
    function test_R19_rotation_gasSweep_neverSkipsPayout() public {
        (Mal_ERC20 tok, TapeAPIEscrow e) = _accrued200(address(this));
        uint256 oks; uint256 fails;
        for (uint256 g = 20_000; g <= 400_000; g += 250) {
            uint256 snap = vm.snapshotState();
            (bool ok,) = address(e).call{gas: g}(abi.encodeCall(TapeAPIEscrow.setTreasury, (address(0x7EA6))));
            if (ok) {
                oks++;
                assertEq(e.treasuryAccrued(), 0, "a successful rotation always paid the outgoing treasury");
                assertEq(tok.balanceOf(treasury), 200 * UNIT);
            } else {
                fails++;
                assertEq(e.treasury(), treasury);
                assertEq(e.treasuryAccrued(), 200 * UNIT);
            }
            vm.revertToState(snap);
        }
        assertGt(oks, 0, "some limit succeeds");
        assertGt(fails, 0, "some limit fails");
    }

    // ---- F-2: setTreasury / constructor refuse the escrow itself and its token ----

    function test_R19_setTreasury_refusesZeroSelfAndToken() public {
        (Mal_ERC20 tok, TapeAPIEscrow e) = _accrued200(address(this));
        vm.expectRevert(ZeroAddress.selector);
        e.setTreasury(address(0));
        vm.expectRevert(BadTreasury.selector);
        e.setTreasury(address(e));
        vm.expectRevert(BadTreasury.selector);
        e.setTreasury(address(tok));
        assertEq(e.treasury(), treasury, "unchanged");
        assertEq(e.treasuryAccrued(), 200 * UNIT, "a refused rotation pays nothing");
        assertEq(tok.balanceOf(treasury), 0);
        vm.prank(address(0xBEEF));
        vm.expectRevert(NotOwner.selector);                    // owner check first: a stranger learns nothing
        e.setTreasury(address(e));
    }

    function test_R19_constructor_refusesTreasuryEqualTokenOrSelf() public {
        Mal_ERC20 tok = new Mal_ERC20();
        vm.expectRevert(BadTreasury.selector);
        new TapeAPIEscrow(address(tok), address(hub), address(tok));
        address next = vm.computeCreateAddress(address(this), vm.getNonce(address(this)));
        vm.expectRevert(BadTreasury.selector);
        new TapeAPIEscrow(address(tok), address(hub), next);
    }

    // ---- F-3: every non-standard token answer is TransferFailed() ----

    function _weird() internal returns (R19_WeirdReturnToken tok, TapeAPIEscrow e) {
        tok = new R19_WeirdReturnToken();
        e = new TapeAPIEscrow(address(tok), address(hub), treasury);
        tok.mint(consumers[0], 1000 * UNIT);
        vm.prank(consumers[0]); tok.approve(address(e), type(uint256).max);
    }

    /// Return payloads that are NOT success: 1 byte, 31 bytes, a 32-byte 0 (false), 2, 2^255, a high-byte 0x01
    /// (value 2^248), and 64 bytes whose first word is 2. Each reverts exactly TransferFailed() on the pull leg
    /// (fund / transferFrom) and on the push leg (settle / transfer), and changes nothing.
    /// 非成功的返回：1 字节、31 字节、32 字节 0、2、2^255、高位字节 0x01、首字为 2 的 64 字节；拉与推两条腿都精确回滚
    /// TransferFailed() 且不改变任何状态。
    function test_R19_nonStandardReturn_isTransferFailed() public {
        bytes[7] memory bad = [
            bytes(hex"01"),
            abi.encodePacked(bytes31(uint248(1))),
            abi.encode(uint256(0)),
            abi.encode(uint256(2)),
            abi.encode(uint256(1) << 255),
            abi.encode(uint256(1) << 248),
            abi.encode(uint256(2), uint256(1))
        ];
        address c = consumers[0]; address p = providers[0];
        for (uint256 i; i < bad.length; i++) {
            (R19_WeirdReturnToken tok, TapeAPIEscrow e) = _weird();
            // push leg needs a funded channel: fund with a canonical answer first
            tok.setRet(abi.encode(true));
            vm.prank(c); e.fund(p, 100 * UNIT);
            tok.setRet(bad[i]);
            vm.prank(c);
            vm.expectRevert(TransferFailed.selector);
            e.fund(p, 1 * UNIT);
            uint64 exp = uint64(block.timestamp + 1 hours);
            bytes memory sig = _sig(e, cpk[0], c, p, 50 * UNIT, exp);
            vm.expectRevert(TransferFailed.selector);
            e.settle(c, p, 50 * UNIT, exp, sig);
            assertEq(e.channelOf(c, p), 100 * UNIT, "nothing changed");
            assertEq(e.claimedOf(c, p), 0);
        }
    }

    /// Success payloads: empty (token has code), exactly 32 bytes == 1, 33 bytes and 64 bytes whose first word is 1.
    function test_R19_standardReturn_isAccepted() public {
        bytes[4] memory good = [
            bytes(""),
            abi.encode(uint256(1)),
            abi.encodePacked(uint256(1), bytes1(0xff)),
            abi.encode(uint256(1), uint256(0xdead))
        ];
        address c = consumers[0]; address p = providers[0];
        for (uint256 i; i < good.length; i++) {
            (R19_WeirdReturnToken tok, TapeAPIEscrow e) = _weird();
            tok.setRet(good[i]);
            vm.prank(c); e.fund(p, 100 * UNIT);
            uint64 exp = uint64(block.timestamp + 1 hours);
            e.settle(c, p, 100 * UNIT, exp, _sig(e, cpk[0], c, p, 100 * UNIT, exp));
            assertEq(tok.balanceOf(p), 99 * UNIT);
            assertEq(e.claimTreasury(), 1 * UNIT);
            assertEq(tok.balanceOf(treasury), 1 * UNIT);
        }
    }

    /// F-3 on the claim and rotation legs. The weird token MOVES the funds and then answers a non-standard payload
    /// (or a lying `false`). claimTreasury reverts TransferFailed(); setTreasury's payout attempt fails -- and is rolled
    /// back in full, so the move is undone: the old treasury holds nothing, the accrual is kept for the new treasury,
    /// and the escrow stays solvent (a direct low-level call here would have paid the accrual twice).
    /// F-3 领取与更换两条腿：怪代币先转账再返回非标准载荷（或撒谎的 false）。claimTreasury 回滚 TransferFailed()；
    /// setTreasury 的付款尝试失败并被完整回滚，转账被撤销：旧金库一无所得、应收留给新金库、托管保持偿付。
    function test_R19_nonStandardReturn_claimAndRotation() public {
        bytes[3] memory bad = [bytes(hex"0001"), abi.encode(false), abi.encode(uint256(7))];
        address c = consumers[0]; address p = providers[0];
        for (uint256 i; i < bad.length; i++) {
            (R19_WeirdReturnToken tok, TapeAPIEscrow e) = _weird();
            tok.setRet(abi.encode(true));
            vm.prank(c); e.fund(p, 100 * UNIT);
            uint64 exp = uint64(block.timestamp + 1 hours);
            e.settle(c, p, 50 * UNIT, exp, _sig(e, cpk[0], c, p, 50 * UNIT, exp));
            uint256 a = e.treasuryAccrued();
            assertGt(a, 0);
            tok.setRet(bad[i]);
            vm.expectRevert(TransferFailed.selector);
            e.claimTreasury();
            address t2 = address(0x7EA6);
            e.setTreasury(t2);
            assertEq(e.treasury(), t2);
            assertEq(e.treasuryAccrued(), a, "a failed payout keeps the accrual");
            assertEq(tok.balanceOf(treasury), 0, "the token's move inside the failed payout was rolled back");
            assertEq(tok.balanceOf(address(e)), e.channelOf(c, p) + e.treasuryAccrued(), "solvent after the rotation");
            tok.setRet(abi.encode(true));
            e.claimTreasury();
            assertEq(tok.balanceOf(t2), a);
            assertEq(tok.balanceOf(address(e)), e.channelOf(c, p), "solvent after the claim");
        }
    }

    /// F-3: a call that REVERTED is failure whatever its revert data looks like -- empty (which would pass the
    /// "no return value + code" rule) or a word of 1 (which would pass the bool rule). Pull, push, claim and rotation.
    /// F-3：回滚的调用一律失败，无论回滚数据长什么样——空（否则会被当成"无返回值且有代码"）或一个值为 1 的字。
    function test_R19_revertingToken_isTransferFailed_whateverItsRevertData() public {
        bytes[2] memory data = [bytes(""), abi.encode(uint256(1))];
        address c = consumers[0]; address p = providers[0];
        for (uint256 i; i < data.length; i++) {
            (R19_WeirdReturnToken tok, TapeAPIEscrow e) = _weird();
            tok.setRet(abi.encode(true));
            vm.prank(c); e.fund(p, 100 * UNIT);
            uint64 exp = uint64(block.timestamp + 1 hours);
            e.settle(c, p, 50 * UNIT, exp, _sig(e, cpk[0], c, p, 50 * UNIT, exp));
            uint256 a = e.treasuryAccrued();
            tok.setRet(data[i]);
            tok.setReverts(true);
            vm.prank(c);
            vm.expectRevert(TransferFailed.selector);
            e.fund(p, 1 * UNIT);
            bytes memory sig = _sig(e, cpk[0], c, p, 60 * UNIT, exp);
            vm.expectRevert(TransferFailed.selector);
            e.settle(c, p, 60 * UNIT, exp, sig);
            vm.expectRevert(TransferFailed.selector);
            e.claimTreasury();
            e.setTreasury(address(0x7EA6));
            assertEq(e.treasuryAccrued(), a, "a reverted payout keeps the accrual");
            assertEq(e.channelOf(c, p), 50 * UNIT);
            assertEq(tok.balanceOf(address(e)), e.channelOf(c, p) + a, "solvent");
        }
    }

    /// F-3: a codeless "token" is refused on every leg (empty return from an address without code is not success).
    function test_R19_codelessToken_refusedOnRotationToo() public {
        address ghost = address(0xC0DE1E55);
        TapeAPIEscrow e = new TapeAPIEscrow(ghost, address(hub), treasury);
        vm.prank(consumers[0]);
        vm.expectRevert(TransferFailed.selector);
        e.fund(providers[0], 1);
        e.setTreasury(address(0x7EA6));    // nothing accrued: no call; still rotates
        assertEq(e.treasury(), address(0x7EA6));
    }

    /// Info: pay * bps overflow is a panic, not a custom error; the channel stays withdrawable and smaller vouchers settle.
    function test_R19_payTimesBpsOverflow_isPanicOnly() public {
        Mal_ERC20 tok = new Mal_ERC20();
        TapeAPIEscrow e = new TapeAPIEscrow(address(tok), address(hub), treasury);
        address c = consumers[0]; address p = providers[0];
        uint256 huge = type(uint256).max / 100 + 1;   // pay * 100 overflows at > max/100
        tok.mint(c, huge); vm.prank(c); tok.approve(address(e), type(uint256).max); vm.prank(c); e.fund(p, huge);
        uint64 exp = uint64(block.timestamp + 1 hours);
        bytes memory sig = _sig(e, cpk[0], c, p, huge, exp);
        vm.expectRevert(stdError.arithmeticError);
        e.settle(c, p, huge, exp, sig);
        uint256 ok_ = type(uint256).max / 100 - 1;
        e.settle(c, p, ok_, exp, _sig(e, cpk[0], c, p, ok_, exp));
        assertEq(e.claimedOf(c, p), ok_);
    }

    /// Replay to a DIFFERENT-token instance (the author's test only uses the same token).
    function test_R19_voucherReplay_differentTokenInstance_rejected() public {
        Mal_ERC20 a = new Mal_ERC20(); Mal_NoReturnToken b = new Mal_NoReturnToken();
        TapeAPIEscrow ea = new TapeAPIEscrow(address(a), address(hub), treasury);
        TapeAPIEscrow eb = new TapeAPIEscrow(address(b), address(hub), treasury);
        address c = consumers[0]; address p = providers[0];
        b.mint(c, 100 * UNIT); vm.prank(c); b.approve(address(eb), type(uint256).max); vm.prank(c); eb.fund(p, 100 * UNIT);
        uint64 exp = uint64(block.timestamp + 1 hours);
        bytes memory sigA = _sig(ea, cpk[0], c, p, 50 * UNIT, exp);
        vm.expectRevert(BadSignature.selector);
        eb.settle(c, p, 50 * UNIT, exp, sigA);
        assertTrue(ea.DOMAIN_SEPARATOR() != eb.DOMAIN_SEPARATOR());
    }
}
