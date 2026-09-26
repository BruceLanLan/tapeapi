// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// ============================================================================================
// Stateful invariant campaign for the v2 escrow (docs/DECISION-escrow-v2.md, "谨慎条款" 2;
// docs/research/RESEARCH-process-security.md 6.1 P0-2; docs/research/RESEARCH-process-channels.md 6.1 item 1).
//
// Runs with `fail_on_revert = true` (foundry.toml). Every handler is an ORACLE: before calling the escrow it
// predicts the outcome from the current state, replaying src's check order exactly. A predicted revert is
// asserted with `vm.expectRevert(<exact error>)`; a predicted success is followed by `assertEq` on every balance
// and storage slot it touches. A wrong prediction therefore reverts the handler and fails the campaign -- no
// try/catch, no ghost "violated" flag, no silently burnt depth.
//
// Actors: 3 consumers x 4 providers (one provider IS consumer #0 -- self-dealing; one IS the treasury) x 2 session
// keys per channel (+1 key that is never authorised). Time moves two ways: a random 1h-72h `warp`, and
// `warpToBoundary`, which lands exactly on requestedAt+48h+/-1s, requestedAt+48h+7d+/-1s, a voucher's
// expires+/-1s or a session's expiry+/-1s and then interleaves settle / withdraw / requestWithdraw /
// cancelWithdraw / authorizeSession in that same block.
//
// Properties:
//   in-handler (fatal)  every call's outcome == the spec oracle; settle pays min(delta, channel) split
//                       pay*bps/1e4 to treasury; withdraw pays min(requested, channel) only inside
//                       [requestedAt+48h, requestedAt+48h+7d]; a voucher that was inside the channel when signed and
//                       is settled before any withdraw executes on that channel (not expired, key live) is paid in
//                       FULL; Σ channel never grows except in `fund`.
//   invariant_*         solvency (Σ channel + Σ paid == Σ funded − Σ withdrawn; escrow balance == Σ channel),
//                       per-channel conservation (funded == channel + claimed + withdrawn), claimed monotone.
//
// 有状态模糊测试（fail_on_revert = true）：每个处理器都是预言机——按源码的检查顺序预测结果，预期回滚用
// vm.expectRevert 精确断言，预期成功则逐项 assertEq。预测错误即处理器回滚、测试失败。
// 时间推进：随机 warp + 精确落在四个时钟边界 ±1 秒的 warpToBoundary，并在同一区块内交错各种操作。
// ============================================================================================

import "forge-std/Test.sol";
import {TapeAPIEscrow} from "../src/TapeAPIEscrow.sol";
import {
    ZeroAmount, Expired, BadSignature, NothingToSettle, InsufficientBalance, NoPendingWithdraw, CooldownActive,
    WithdrawWindowClosed, SessionTooLong, SessionShorteningNotSupported
} from "../src/interfaces.sol";

contract Inv_MockERC20 {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    function mint(address to, uint256 amt) external { balanceOf[to] += amt; }
    function approve(address s, uint256 amt) external returns (bool) { allowance[msg.sender][s] = amt; return true; }
    function transfer(address to, uint256 amt) external returns (bool) { balanceOf[msg.sender] -= amt; balanceOf[to] += amt; return true; }
    function transferFrom(address f, address to, uint256 amt) external returns (bool) {
        allowance[f][msg.sender] -= amt; balanceOf[f] -= amt; balanceOf[to] += amt; return true;
    }
}

contract Inv_MockERC721 {
    mapping(uint256 => address) public ownerOf;
    function mint(address to, uint256 id) external { ownerOf[id] = to; }
}

contract Inv_MockHub {
    function accountOf(address circuits, uint256 tokenId) external pure returns (address) {
        return address(uint160(uint256(keccak256(abi.encode("container", circuits, tokenId)))));
    }
}

contract EscrowHandler is Test {
    TapeAPIEscrow public escrow;
    Inv_MockERC20 public bem;
    Inv_MockERC721 public nft;
    address public treasury;
    address public holder;

    // cached so no view call ever sits between vm.expectRevert and the call it targets
    // 缓存常量：vm.expectRevert 与目标调用之间不得夹任何外部视图调用
    uint64 internal COOLDOWN;
    uint64 internal WINDOW;
    uint64 internal MAX_SESSION;

    uint256[3] internal consumerPk;
    address[3] public consumers;
    address[4] public providers;      // [container1, container2, consumers[0], treasury]
    uint256[2] internal sessionPk;
    address[2] public sessionKeys;
    uint256 internal constant ROGUE_PK = 0xBAD5E55;   // never authorised anywhere / 从未被授权的密钥

    // ---- ghost state / 影子状态 ----
    uint256 public totalFunded;
    uint256 public totalWithdrawn;
    uint256 public totalPaid;                 // to providers + treasury, measured by token balance deltas / 按代币余额差计量
    mapping(address => mapping(address => uint256)) public fundedOf;
    mapping(address => mapping(address => uint256)) public withdrawnOf;
    mapping(address => mapping(address => uint256)) public lastClaimed;
    mapping(address => mapping(address => uint256)) public withdrawEpoch;   // bumps on each executed withdraw / 每次成功提现 +1
    mapping(string => uint256) public calls;

    struct Outstanding {
        address consumer; address provider; address signer; uint256 pk;
        uint256 cumulative; uint64 expires; bytes sig;
        bool inRange; uint256 epoch;
    }
    Outstanding[] internal outstanding;
    uint256 internal constant MAX_OUTSTANDING = 48;
    uint256 internal constant UNIT = 1e8;   // BEM has 8 decimals / BEM 为 8 位小数

    constructor(TapeAPIEscrow escrow_, Inv_MockERC20 bem_, Inv_MockERC721 nft_, address treasury_, address holder_) {
        escrow = escrow_; bem = bem_; nft = nft_; treasury = treasury_; holder = holder_;
        COOLDOWN = escrow.WITHDRAW_COOLDOWN(); WINDOW = escrow.WITHDRAW_WINDOW(); MAX_SESSION = escrow.MAX_SESSION();
        consumerPk = [uint256(0xC0FFEE1), 0xC0FFEE2, 0xC0FFEE3];
        sessionPk = [uint256(0x5E551), 0x5E552];
        for (uint256 i = 0; i < 3; i++) {
            consumers[i] = vm.addr(consumerPk[i]);
            vm.prank(consumers[i]);
            bem.approve(address(escrow), type(uint256).max);
        }
        for (uint256 i = 0; i < 2; i++) sessionKeys[i] = vm.addr(sessionPk[i]);
        providers[0] = Inv_MockHub(address(escrow.hub())).accountOf(address(nft), 1);
        providers[1] = Inv_MockHub(address(escrow.hub())).accountOf(address(nft), 2);
        providers[2] = consumers[0];   // self-dealing shape / 自我交易形状
        providers[3] = treasury;       // provider == treasury / 提供者即金库
    }

    // ---- Euler-style post-condition: only `fund` may grow Σ channel / 只有 fund 能增加通道总额 ----
    modifier noChannelGrowth() {
        uint256 before = _sumChannels();
        _;
        assertLe(_sumChannels(), before, "sum of channels grew outside fund");
    }

    // ---- selection helpers / 选择工具 ----
    function _p(uint256 s) internal view returns (address) { return providers[s % 4]; }
    function _now() internal view returns (uint64) { return uint64(block.timestamp); }
    function _min(uint256 a, uint256 b) internal pure returns (uint256) { return a < b ? a : b; }
    function _monotone(address c, address p) internal {
        uint256 cl = escrow.claimedOf(c, p);
        assertGe(cl, lastClaimed[c][p], "claimed decreased");
        lastClaimed[c][p] = cl;
    }
    function _sign(uint256 pk, address c, address p, uint256 cumulative, uint64 expires) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, escrow.voucherDigest(c, p, cumulative, expires));
        return abi.encodePacked(r, s, v);
    }
    function _sumChannels() internal view returns (uint256 s) {
        for (uint256 i = 0; i < 3; i++) for (uint256 j = 0; j < 4; j++) s += escrow.channelOf(consumers[i], providers[j]);
    }

    // =========================================================================================
    // Oracles (internal): shared by the plain handlers and by warpToBoundary / 预言机（内部）
    // =========================================================================================

    function _doFund(uint256 ci, address p, uint256 amount) internal {
        address c = consumers[ci];
        uint256 chBefore = escrow.channelOf(c, p);
        uint256 escBefore = bem.balanceOf(address(escrow));
        bem.mint(c, amount);
        vm.prank(c);
        escrow.fund(p, amount);
        assertEq(escrow.channelOf(c, p), chBefore + amount, "fund: channel");
        assertEq(bem.balanceOf(address(escrow)), escBefore + amount, "fund: escrow balance");
        totalFunded += amount;
        fundedOf[c][p] += amount;
    }

    function _doRequestWithdraw(address c, address p, uint256 amountSeed) internal {
        uint256 ch = escrow.channelOf(c, p);
        if (ch == 0) {
            uint256 amount = bound(amountSeed, 1, type(uint128).max);
            vm.expectRevert(InsufficientBalance.selector);
            vm.prank(c);
            escrow.requestWithdraw(p, amount);
            calls["requestWithdraw_revert"]++;
            return;
        }
        uint256 amt = bound(amountSeed, 1, ch);
        vm.prank(c);
        escrow.requestWithdraw(p, amt);
        (uint256 a, uint64 at) = escrow.pendingWithdraw(c, p);
        assertEq(a, amt, "request: amount");
        assertEq(at, _now(), "request: requestedAt");
        calls["requestWithdraw_ok"]++;
    }

    function _doCancel(address c, address p) internal {
        (, uint64 at) = escrow.pendingWithdraw(c, p);
        if (at == 0) {
            vm.expectRevert(NoPendingWithdraw.selector);
            vm.prank(c);
            escrow.cancelWithdraw(p);
            calls["cancel_revert"]++;
            return;
        }
        vm.prank(c);
        escrow.cancelWithdraw(p);
        (uint256 a2, uint64 at2) = escrow.pendingWithdraw(c, p);
        assertEq(a2, 0, "cancel: amount"); assertEq(at2, 0, "cancel: requestedAt");
        calls["cancel_ok"]++;
    }

    /// @dev Spec: NoPendingWithdraw | CooldownActive(availableAt) | WithdrawWindowClosed | InsufficientBalance (request
    ///      survives, the revert rolls the delete back) | pays min(requested, channel) and clears the request.
    function _doWithdraw(address c, address p) internal returns (bool ok) {
        (uint256 amt, uint64 at) = escrow.pendingWithdraw(c, p);
        uint256 ch = escrow.channelOf(c, p);
        if (amt == 0) {
            vm.expectRevert(NoPendingWithdraw.selector);
            vm.prank(c); escrow.withdraw(p);
            calls["withdraw_revert_none"]++;
            return false;
        }
        uint64 avail = at + COOLDOWN;
        if (block.timestamp < avail) {
            vm.expectRevert(abi.encodeWithSelector(CooldownActive.selector, avail));
            vm.prank(c); escrow.withdraw(p);
            calls["withdraw_revert_cooldown"]++;
            if (block.timestamp + 1 == avail) calls["edge_withdraw_cooldown_minus1"]++;
            return false;
        }
        if (block.timestamp > avail + WINDOW) {
            vm.expectRevert(WithdrawWindowClosed.selector);
            vm.prank(c); escrow.withdraw(p);
            calls["withdraw_revert_window"]++;
            if (block.timestamp == uint256(avail) + WINDOW + 1) calls["edge_withdraw_window_plus1"]++;
            return false;
        }
        uint256 take = _min(amt, ch);
        if (take == 0) {
            vm.expectRevert(InsufficientBalance.selector);
            vm.prank(c); escrow.withdraw(p);
            (uint256 a2, uint64 at2) = escrow.pendingWithdraw(c, p);
            assertEq(a2, amt, "drained withdraw: request must survive"); assertEq(at2, at, "drained withdraw: requestedAt");
            calls["withdraw_revert_drained"]++;
            return false;
        }
        uint256 before = bem.balanceOf(c);
        vm.prank(c); escrow.withdraw(p);
        assertEq(bem.balanceOf(c) - before, take, "withdraw: pays min(requested, channel)");
        assertEq(escrow.channelOf(c, p), ch - take, "withdraw: channel");
        (uint256 a3, uint64 at3) = escrow.pendingWithdraw(c, p);
        assertEq(a3, 0, "withdraw: request cleared"); assertEq(at3, 0, "withdraw: requestedAt cleared");
        totalWithdrawn += take;
        withdrawnOf[c][p] += take;
        withdrawEpoch[c][p]++;
        calls["withdraw_ok"]++;
        if (block.timestamp == avail) calls["edge_withdraw_at_cooldown"]++;
        if (block.timestamp == uint256(avail) + WINDOW) calls["edge_withdraw_last_second"]++;
        _monotone(c, p);
        return true;
    }

    function _doAuthorize(address c, address p, address k, uint256 seed) internal {
        uint64 cur = escrow.sessionExpiry(c, p, k);
        uint256 lo = cur > block.timestamp + 1 ? cur : block.timestamp + 1;   // extend-only / 只可延长
        uint256 hi = block.timestamp + MAX_SESSION;                              // cur <= its auth time + MAX <= hi
        uint64 expires = uint64(bound(seed, lo, hi));
        vm.prank(c);
        escrow.authorizeSession(p, k, expires);
        assertEq(escrow.sessionExpiry(c, p, k), expires, "authorize: expiry");
        calls["authorize_ok"]++;
    }

    /// @dev Consumer-chosen deadline for a fresh voucher; ttl 0 means `expires == now` (the inclusive edge).
    function _fresh(uint256 ci, address p, bool useSession, uint256 ks, uint256 deltaSeed, uint64 expires)
        internal view returns (Outstanding memory o)
    {
        o.consumer = consumers[ci];
        o.provider = p;
        o.expires = expires;
        o.epoch = withdrawEpoch[o.consumer][p];
        uint256 ch = escrow.channelOf(o.consumer, p);
        // deltas up to 1.5x the channel so some vouchers are deliberately out of range / 部分凭证刻意超出通道
        uint256 delta = bound(deltaSeed, 1, ch == 0 ? 10 * UNIT : ch + ch / 2 + 1);
        o.cumulative = escrow.claimedOf(o.consumer, p) + delta;
        if (useSession) { o.pk = sessionPk[ks % 2]; o.signer = sessionKeys[ks % 2]; }
        else { o.pk = consumerPk[ci]; o.signer = o.consumer; }
        o.inRange = delta <= ch
            && (o.signer == o.consumer || escrow.sessionExpiry(o.consumer, p, o.signer) >= block.timestamp);
        o.sig = _sign(o.pk, o.consumer, p, o.cumulative, expires);
    }

    struct Snap { uint256 ch; uint256 cl; uint256 pBal; uint256 tBal; uint256 bps; uint64 keyExp; bool liveNow; bool mustPayInFull; }

    function _snap(Outstanding memory o) internal view returns (Snap memory sn) {
        sn.ch = escrow.channelOf(o.consumer, o.provider);
        sn.cl = escrow.claimedOf(o.consumer, o.provider);
        sn.pBal = bem.balanceOf(o.provider);
        sn.tBal = bem.balanceOf(treasury);
        sn.bps = escrow.contributionOf(o.provider);
        sn.keyExp = escrow.sessionExpiry(o.consumer, o.provider, o.signer);
        sn.liveNow = o.signer == o.consumer || sn.keyExp >= block.timestamp;
        // precondition of "payable in full": in range at signing, no withdraw executed since, not expired, key live
        // "足额兑付"前提：签发时在通道内、其后无已执行提现、未过期、密钥仍有效
        sn.mustPayInFull = o.inRange && withdrawEpoch[o.consumer][o.provider] == o.epoch
            && block.timestamp <= o.expires && sn.liveNow;
    }

    function _expectedSettleError(Outstanding memory o, Snap memory sn) internal view returns (bytes memory) {
        if (block.timestamp > o.expires) return abi.encodeWithSelector(Expired.selector);
        if (!sn.liveNow) return abi.encodeWithSelector(BadSignature.selector);
        if (o.cumulative <= sn.cl) return abi.encodeWithSelector(NothingToSettle.selector);
        if (sn.ch == 0) return abi.encodeWithSelector(InsufficientBalance.selector);
        return "";
    }

    /// @dev Replays settle's check order: Expired > BadSignature (session not live now) > NothingToSettle >
    ///      InsufficientBalance > pay min(delta, channel), contribution floor(pay*bps/1e4) to treasury.
    function _settle(Outstanding memory o) internal returns (bool ok) {
        Snap memory sn = _snap(o);
        if (o.signer != o.consumer && block.timestamp == sn.keyExp) calls["edge_settle_at_session_expiry"]++;
        if (block.timestamp == o.expires) calls["edge_settle_at_voucher_expiry"]++;

        bytes memory err = _expectedSettleError(o, sn);
        if (err.length != 0) {
            vm.expectRevert(err);
            escrow.settle(o.consumer, o.provider, o.cumulative, o.expires, o.sig);
            calls["settle_revert"]++;
            if (block.timestamp == uint256(o.expires) + 1) calls["edge_settle_voucher_expiry_plus1"]++;
            if (o.signer != o.consumer && block.timestamp == uint256(sn.keyExp) + 1 && block.timestamp <= o.expires) {
                calls["edge_settle_session_expiry_plus1"]++;
            }
        } else {
            uint256 pay = _min(o.cumulative - sn.cl, sn.ch);
            uint256 contribution = pay * sn.bps / 10_000;
            escrow.settle(o.consumer, o.provider, o.cumulative, o.expires, o.sig);
            if (o.provider == treasury) {
                assertEq(bem.balanceOf(o.provider) - sn.pBal, pay, "settle: provider==treasury receives pay");
            } else {
                assertEq(bem.balanceOf(o.provider) - sn.pBal, pay - contribution, "settle: provider share");
                assertEq(bem.balanceOf(treasury) - sn.tBal, contribution, "settle: treasury share");
            }
            assertEq(escrow.claimedOf(o.consumer, o.provider), sn.cl + pay, "settle: claimed += pay");
            assertEq(escrow.channelOf(o.consumer, o.provider), sn.ch - pay, "settle: channel -= pay");
            totalPaid += pay;
            ok = true;
            calls["settle_ok"]++;
            if (pay < o.cumulative - sn.cl) calls["settle_partial"]++;
        }
        if (sn.mustPayInFull) {
            assertGe(escrow.claimedOf(o.consumer, o.provider), o.cumulative,
                "in-range voucher settled before any withdraw was not paid in full");
        }
        _monotone(o.consumer, o.provider);
    }

    function _push(Outstanding memory o, uint256 slotSeed) internal {
        if (outstanding.length >= MAX_OUTSTANDING) outstanding[slotSeed % MAX_OUTSTANDING] = o;
        else outstanding.push(o);
    }

    // =========================================================================================
    // Handlers (external) / 处理器
    // =========================================================================================

    function fund(uint256 cs, uint256 ps, uint256 amount) external {
        calls["fund"]++;
        _doFund(cs % 3, _p(ps), bound(amount, 1, 1_000 * UNIT));
    }

    function requestWithdraw(uint256 cs, uint256 ps, uint256 amount) external noChannelGrowth {
        calls["requestWithdraw"]++;
        _doRequestWithdraw(consumers[cs % 3], _p(ps), amount);
    }

    /// @dev The three input-validation reverts, asserted exactly / 三种输入校验回滚
    function requestWithdrawReverts(uint256 cs, uint256 ps, uint256 amount, uint8 which) external noChannelGrowth {
        calls["requestWithdrawReverts"]++;
        address c = consumers[cs % 3]; address p = _p(ps);
        uint256 ch = escrow.channelOf(c, p);
        (uint256 a0, uint64 at0) = escrow.pendingWithdraw(c, p);
        if (which % 3 == 0) {
            vm.expectRevert(ZeroAmount.selector);
            vm.prank(c); escrow.requestWithdraw(p, 0);
        } else if (which % 3 == 1) {
            vm.expectRevert(InsufficientBalance.selector);
            vm.prank(c); escrow.requestWithdraw(p, bound(amount, ch + 1, type(uint256).max));
        } else {
            vm.expectRevert(ZeroAmount.selector);
            vm.prank(c); escrow.fund(p, 0);
        }
        (uint256 a1, uint64 at1) = escrow.pendingWithdraw(c, p);
        assertEq(a1, a0); assertEq(at1, at0);
    }

    function cancelWithdraw(uint256 cs, uint256 ps) external noChannelGrowth {
        calls["cancelWithdraw"]++;
        _doCancel(consumers[cs % 3], _p(ps));
    }

    function withdraw(uint256 cs, uint256 ps) external noChannelGrowth {
        calls["withdraw"]++;
        _doWithdraw(consumers[cs % 3], _p(ps));
    }

    function authorizeSession(uint256 cs, uint256 ps, uint256 ks, uint256 seed) external noChannelGrowth {
        calls["authorizeSession"]++;
        _doAuthorize(consumers[cs % 3], _p(ps), sessionKeys[ks % 2], seed);
    }

    /// @dev Expired / SessionTooLong(max) / SessionShorteningNotSupported, asserted exactly / 三种会话授权回滚
    function authorizeSessionReverts(uint256 cs, uint256 ps, uint256 ks, uint256 seed, uint8 which) external noChannelGrowth {
        calls["authorizeSessionReverts"]++;
        address c = consumers[cs % 3]; address p = _p(ps); address k = sessionKeys[ks % 2];
        uint64 cur = escrow.sessionExpiry(c, p, k);
        uint64 max = _now() + MAX_SESSION;
        uint8 w = which % 3;
        if (w == 2 && cur <= block.timestamp + 1) w = 0;   // nothing to shorten / 无可缩短
        if (w == 0) {
            vm.expectRevert(Expired.selector);
            vm.prank(c); escrow.authorizeSession(p, k, uint64(bound(seed, 0, block.timestamp)));
        } else if (w == 1) {
            vm.expectRevert(abi.encodeWithSelector(SessionTooLong.selector, max));
            vm.prank(c); escrow.authorizeSession(p, k, uint64(bound(seed, uint256(max) + 1, type(uint64).max)));
        } else {
            vm.expectRevert(SessionShorteningNotSupported.selector);
            vm.prank(c); escrow.authorizeSession(p, k, uint64(bound(seed, block.timestamp + 1, uint256(cur) - 1)));
        }
        assertEq(escrow.sessionExpiry(c, p, k), cur, "failed authorize changed the expiry");
    }

    /// @dev Sign now, settle later (possibly after warps / other settles / withdraws) -- this is what exercises the
    ///      "payable in full inside the cooldown" property. / 先签后结，覆盖跨时间、跨其它操作的结算。
    function signVoucher(uint256 cs, uint256 ps, uint256 ks, bool useSession, uint256 deltaSeed, uint64 ttl) external noChannelGrowth {
        calls["signVoucher"]++;
        uint64 expires = _now() + uint64(bound(ttl, 0, 10 days));
        _push(_fresh(cs % 3, _p(ps), useSession, ks, deltaSeed, expires), deltaSeed);
    }

    function settleOutstanding(uint256 idx) external noChannelGrowth {
        calls["settleOutstanding"]++;
        if (outstanding.length == 0) {
            // nothing queued: settle a fresh consumer-signed voucher instead so the call still advances state
            // 队列为空：改为结算一张新凭证，保证调用推进状态
            _settle(_fresh(idx % 3, _p(idx >> 8), false, 0, idx >> 16, _now()));
            return;
        }
        idx = idx % outstanding.length;
        Outstanding memory o = outstanding[idx];
        _settle(o);
        // drop it once expired or fully covered / 过期或已覆盖后移除
        if (block.timestamp > o.expires || escrow.claimedOf(o.consumer, o.provider) >= o.cumulative) {
            outstanding[idx] = outstanding[outstanding.length - 1];
            outstanding.pop();
        }
    }

    /// @dev Sign and settle in one call, to keep the settle landing rate high. / 签发即结算，提高落地率。
    function settleFresh(uint256 cs, uint256 ps, uint256 ks, bool useSession, uint256 deltaSeed, uint64 ttl) external noChannelGrowth {
        calls["settleFresh"]++;
        uint64 expires = _now() + uint64(bound(ttl, 0, 2 hours));
        _settle(_fresh(cs % 3, _p(ps), useSession, ks, deltaSeed, expires));
    }

    /// @dev Signed by a key that is neither the consumer nor authorised on any channel: always BadSignature.
    function settleForged(uint256 cs, uint256 ps, uint256 deltaSeed) external noChannelGrowth {
        calls["settleForged"]++;
        address c = consumers[cs % 3]; address p = _p(ps);
        uint256 cum = escrow.claimedOf(c, p) + bound(deltaSeed, 1, 1_000 * UNIT);
        uint64 exp = _now() + 1 hours;
        bytes memory sig = _sign(ROGUE_PK, c, p, cum, exp);
        uint256 ch = escrow.channelOf(c, p);
        vm.expectRevert(BadSignature.selector);
        escrow.settle(c, p, cum, exp, sig);
        assertEq(escrow.channelOf(c, p), ch);
    }

    function setContribution(uint256 ps, uint16 bps) external noChannelGrowth {
        calls["setContribution"]++;
        uint256 tokenId = ps % 2 + 1;
        bps = uint16(bound(bps, 0, escrow.MAX_CONTRIBUTION_BPS()));
        vm.prank(holder);
        escrow.setContribution(address(nft), tokenId, bps);
        assertEq(escrow.contributionOf(providers[tokenId - 1]), bps);
    }

    function warp(uint256 secs) external {
        calls["warp"]++;
        vm.warp(block.timestamp + bound(secs, 1 hours, 72 hours));
    }

    /// @dev Land exactly on one of the four clocks of channel (c, p), offset -1 / 0 / +1 second, then run up to four
    ///      interleaved actions in that same block. If the chosen clock is not armed or already in the past, arm it
    ///      now (requestWithdraw / sign a voucher / authorizeSession) -- never warp backwards.
    ///      精确跳到通道 (c, p) 某个时钟的 -1/0/+1 秒，并在同一区块内交错最多四个操作。时钟未设置或已过去时先设置它
    ///      （requestWithdraw / 签凭证 / authorizeSession），绝不回拨时间。
    function warpToBoundary(uint256 cs, uint256 ps, uint256 ks, uint8 which, uint8 offSeed, uint256 follow) external {
        calls["warpToBoundary"]++;
        uint256 ci = cs % 3;
        address p = _p(ps);
        int256 off = int256(uint256(offSeed % 3)) - 1;
        uint256 w = which % 4;
        uint256 target;
        uint256 vIdx;
        if (w <= 1) target = _armWithdrawClock(ci, p, w == 1, off, follow);
        else if (w == 2) (target, vIdx) = _armVoucherClock(ci, p, ks, off, follow);
        else target = _armSessionClock(ci, p, ks, off, follow);
        if (target > block.timestamp) vm.warp(target);
        calls[w == 0 ? "boundary_cooldown" : w == 1 ? "boundary_window" : w == 2 ? "boundary_voucher" : "boundary_session"]++;

        // The clock's own action first, then three more interleaved in the same second.
        // 先执行该时钟对应的操作，再在同一秒内交错三个操作。
        address c = consumers[ci];
        if (w == 0) {
            // provider's last-second settle vs consumer's first-second withdraw, in either order / 两种顺序
            if (follow & 1 == 0) { _settle(_fresh(ci, p, false, 0, follow >> 8, _now())); _doWithdraw(c, p); }
            else { _doWithdraw(c, p); _settle(_fresh(ci, p, false, 0, follow >> 8, _now())); }
        } else if (w == 1) {
            _doWithdraw(c, p);
        } else if (w == 2) {
            _settle(outstanding[vIdx]);
        } else {
            _settle(_fresh(ci, p, true, ks, follow >> 8, _now() + uint64(follow % 2 hours)));
        }
        _interleave(ci, p, ks, follow);
    }

    /// @dev requestedAt + 48h (+ 7d) + off; (re-)arms a request now if none is pending or its edge has passed.
    function _armWithdrawClock(uint256 ci, address p, bool windowEnd, int256 off, uint256 follow) internal returns (uint256) {
        address c = consumers[ci];
        uint256 span = uint256(COOLDOWN) + (windowEnd ? WINDOW : 0);
        (uint256 amt, uint64 at) = escrow.pendingWithdraw(c, p);
        if (amt == 0 || int256(uint256(at) + span) + off < int256(block.timestamp)) {
            if (escrow.channelOf(c, p) == 0) _doFund(ci, p, bound(follow, 1, 1_000 * UNIT));
            _doRequestWithdraw(c, p, follow >> 64);
            at = _now();
        }
        return uint256(int256(uint256(at) + span) + off);
    }

    /// @dev A queued voucher's expires + off on this channel; signs a fresh one if none is still reachable.
    function _armVoucherClock(uint256 ci, address p, uint256 ks, int256 off, uint256 follow)
        internal returns (uint256 target, uint256 vIdx)
    {
        address c = consumers[ci];
        vIdx = type(uint256).max;
        for (uint256 i = 0; i < outstanding.length; i++) {
            Outstanding storage q = outstanding[i];
            if (q.consumer == c && q.provider == p && int256(uint256(q.expires)) + off >= int256(block.timestamp)) { vIdx = i; break; }
        }
        if (vIdx == type(uint256).max) {
            if (escrow.channelOf(c, p) == 0) _doFund(ci, p, bound(follow, 1, 1_000 * UNIT));
            uint64 exp = _now() + uint64(bound(follow >> 64, 1, 10 days));
            uint256 lenBefore = outstanding.length;
            _push(_fresh(ci, p, (follow >> 128) & 1 == 1, ks, follow >> 136, exp), follow);
            vIdx = lenBefore < MAX_OUTSTANDING ? lenBefore : follow % MAX_OUTSTANDING;
        }
        target = uint256(int256(uint256(outstanding[vIdx].expires)) + off);
    }

    /// @dev sessionExpiry(c, p, k) + off; extends the session now if its edge has passed.
    function _armSessionClock(uint256 ci, address p, uint256 ks, int256 off, uint256 follow) internal returns (uint256) {
        address c = consumers[ci]; address k = sessionKeys[ks % 2];
        uint64 cur = escrow.sessionExpiry(c, p, k);
        if (int256(uint256(cur)) + off < int256(block.timestamp)) {
            _doAuthorize(c, p, k, follow >> 64);
            cur = escrow.sessionExpiry(c, p, k);
        }
        return uint256(int256(uint256(cur)) + off);
    }

    /// @dev Three more actions on the same channel in the same second / 同一秒内再交错三个操作
    function _interleave(uint256 ci, address p, uint256 ks, uint256 follow) internal {
        address c = consumers[ci]; address k = sessionKeys[ks % 2];
        for (uint256 i = 0; i < 3; i++) {
            uint256 a = (follow >> (160 + i * 8)) % 6;
            if (a == 0) _settle(_fresh(ci, p, (follow >> (200 + i)) & 1 == 1, ks, follow >> (i * 16), _now()));
            else if (a == 1) _doWithdraw(c, p);
            else if (a == 2) _doRequestWithdraw(c, p, follow >> (i * 24));
            else if (a == 3) _doCancel(c, p);
            else if (a == 4) _doAuthorize(c, p, k, follow >> (i * 32));
            else if (outstanding.length > 0) _settle(outstanding[(follow >> (i * 40)) % outstanding.length]);
        }
    }

    // ---- views for the invariants / 供不变量使用 ----
    function sumChannels() external view returns (uint256) { return _sumChannels(); }
    function outstandingCount() external view returns (uint256) { return outstanding.length; }
}

contract EscrowInvariantTest is Test {
    Inv_MockERC20 bem;
    Inv_MockERC721 nft;
    Inv_MockHub hub;
    TapeAPIEscrow escrow;
    EscrowHandler handler;
    address treasury = address(0x7EA5);
    address holder = address(0xA11CE);

    function setUp() public {
        vm.warp(1_758_300_000);
        bem = new Inv_MockERC20();
        nft = new Inv_MockERC721();
        hub = new Inv_MockHub();
        nft.mint(holder, 1);
        nft.mint(holder, 2);
        escrow = new TapeAPIEscrow(address(bem), address(hub), treasury);
        handler = new EscrowHandler(escrow, bem, nft, treasury, holder);

        targetContract(address(handler));
        bytes4[] memory sels = new bytes4[](15);
        sels[0] = handler.fund.selector;
        sels[1] = handler.requestWithdraw.selector;
        sels[2] = handler.requestWithdrawReverts.selector;
        sels[3] = handler.cancelWithdraw.selector;
        sels[4] = handler.withdraw.selector;
        sels[5] = handler.authorizeSession.selector;
        sels[6] = handler.authorizeSessionReverts.selector;
        sels[7] = handler.signVoucher.selector;
        sels[8] = handler.settleOutstanding.selector;
        sels[9] = handler.settleFresh.selector;
        sels[10] = handler.settleForged.selector;
        sels[11] = handler.setContribution.selector;
        sels[12] = handler.warp.selector;
        sels[13] = handler.warpToBoundary.selector;
        sels[14] = handler.warpToBoundary.selector;   // weighted x2: the clock edges are the point / 边界动作加权
        targetSelector(FuzzSelector({addr: address(handler), selectors: sels}));
    }

    /// @dev Σ channel + Σ paid == Σ funded − Σ withdrawn, and the token the escrow holds is exactly Σ channel.
    function invariant_solvency() public view {
        uint256 channels = handler.sumChannels();
        assertEq(channels + handler.totalPaid(), handler.totalFunded() - handler.totalWithdrawn(), "solvency identity");
        assertEq(bem.balanceOf(address(escrow)), channels, "escrow holds exactly the sum of channels");
    }

    /// @dev claimedOf never decreases on any channel (the handler snapshots after every op; re-check here too).
    function invariant_claimedMonotone() public view {
        for (uint256 i = 0; i < 3; i++) {
            for (uint256 j = 0; j < 4; j++) {
                address c = handler.consumers(i); address p = handler.providers(j);
                assertGe(escrow.claimedOf(c, p), handler.lastClaimed(c, p), "claimed regressed");
            }
        }
    }

    /// @dev Per channel: funded == channel + claimed + withdrawn. Implies no settle ever paid more than the channel
    ///      held (claimed <= funded − withdrawn) and that no channel can pay out of another's funds. The per-call
    ///      forms ("paid <= channel", "in-range vouchers pay in full") are asserted inside the handler, where under
    ///      fail_on_revert they are fatal.
    ///      按通道守恒：充值 == 余额 + 已结算 + 已提现；逐次调用的断言在处理器内部，fail_on_revert 下即致命。
    function invariant_noOverpayment_andInRangeVouchersPayInFull() public view {
        for (uint256 i = 0; i < 3; i++) {
            for (uint256 j = 0; j < 4; j++) {
                address c = handler.consumers(i); address p = handler.providers(j);
                assertEq(
                    handler.fundedOf(c, p),
                    escrow.channelOf(c, p) + escrow.claimedOf(c, p) + handler.withdrawnOf(c, p),
                    "per-channel conservation"
                );
            }
        }
    }

    /// @dev Not a property: prints the landing rates under -vv so an all-green run cannot be an empty one.
    function invariant_callSummary() public view {
        console2.log("fund                     ", handler.calls("fund"));
        console2.log("request ok/revert        ", handler.calls("requestWithdraw_ok"), handler.calls("requestWithdraw_revert"));
        console2.log("cancel ok/revert         ", handler.calls("cancel_ok"), handler.calls("cancel_revert"));
        console2.log("withdraw ok              ", handler.calls("withdraw_ok"));
        console2.log("withdraw rev none/cool   ", handler.calls("withdraw_revert_none"), handler.calls("withdraw_revert_cooldown"));
        console2.log("withdraw rev window/drain", handler.calls("withdraw_revert_window"), handler.calls("withdraw_revert_drained"));
        console2.log("authorize ok             ", handler.calls("authorize_ok"));
        console2.log("settle ok/partial/revert ", handler.calls("settle_ok"), handler.calls("settle_partial"));
        console2.log("settle revert            ", handler.calls("settle_revert"));
        console2.log("boundary cooldown/window ", handler.calls("boundary_cooldown"), handler.calls("boundary_window"));
        console2.log("boundary voucher/session ", handler.calls("boundary_voucher"), handler.calls("boundary_session"));
        console2.log("edge wd@avail / avail-1  ", handler.calls("edge_withdraw_at_cooldown"), handler.calls("edge_withdraw_cooldown_minus1"));
        console2.log("edge wd@last / last+1    ", handler.calls("edge_withdraw_last_second"), handler.calls("edge_withdraw_window_plus1"));
        console2.log("edge settle@exp / exp+1  ", handler.calls("edge_settle_at_voucher_expiry"), handler.calls("edge_settle_voucher_expiry_plus1"));
        console2.log("edge settle@key / key+1  ", handler.calls("edge_settle_at_session_expiry"), handler.calls("edge_settle_session_expiry_plus1"));
        console2.log("warp                     ", handler.calls("warp"));
        console2.log("outstanding queue        ", handler.outstandingCount());
    }
}
