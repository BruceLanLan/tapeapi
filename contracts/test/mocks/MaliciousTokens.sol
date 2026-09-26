// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// ============================================================================================
// Hostile-token family for the escrow (docs/research/RESEARCH-process-security.md 6.1 P0-3, Penpie / Curve lessons).
// BEM is none of these (mainnet fork, docs/AUDIT-predeploy.md 389-398); they exist so that the escrow's behaviour
// against each is PINNED by a test instead of assumed.
// 恶意代币家族：BEM 不属于其中任何一种；它们的存在是为了用测试钉住托管对每一种的行为，而不是靠假设。
// ============================================================================================

import {TapeAPIEscrow} from "../../src/TapeAPIEscrow.sol";

/// @dev Plain 8-decimal ERC-20 with an overridable `_move` / 可覆写 `_move` 的普通代币
contract Mal_ERC20 {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    function mint(address to, uint256 amt) external { balanceOf[to] += amt; }
    function approve(address s, uint256 amt) external returns (bool) { allowance[msg.sender][s] = amt; return true; }
    function transfer(address to, uint256 amt) external virtual returns (bool) { _move(msg.sender, to, amt); return true; }
    function transferFrom(address f, address to, uint256 amt) external virtual returns (bool) {
        allowance[f][msg.sender] -= amt;
        _move(f, to, amt);
        return true;
    }
    function _move(address f, address to, uint256 amt) internal virtual { balanceOf[f] -= amt; balanceOf[to] += amt; }
}

contract Mal_ERC721 {
    mapping(uint256 => address) public ownerOf;
    function mint(address to, uint256 id) external { ownerOf[id] = to; }
}

contract Mal_Hub {
    function accountOf(address circuits, uint256 tokenId) external pure returns (address) {
        return address(uint160(uint256(keccak256(abi.encode("container", circuits, tokenId)))));
    }
}

/// @dev A hub that derives no container (returns address(0)) / 推导不出容器的 hub
contract Mal_ZeroHub {
    function accountOf(address, uint256) external pure returns (address) { return address(0); }
}

/// @dev A token that calls back INTO THE ESCROW ITSELF from inside `transfer` / `transferFrom` (no external hook
///      contract: the token is the attacker). It also owns a funded channel with a live withdraw request, so that if
///      the guard were missing the re-entrant `withdraw` / `fund` would actually do something.
///      `bubble == false`: the re-entrant call is try/caught and its revert data recorded (the outer call goes on).
///      `bubble == true` : the re-entrant revert propagates, so the token's transfer itself fails.
///      在 transfer / transferFrom 内部直接回调托管本身的代币（代币即攻击者）。它自己也持有一条已充值、带提现请求的
///      通道，这样若没有重入锁，重入的 withdraw / fund 会真的生效。
contract Mal_ReentrantToken is Mal_ERC20 {
    enum Target { None, Settle, Withdraw, Fund, RequestWithdraw, CancelWithdraw, AuthorizeSession }

    TapeAPIEscrow public escrow;
    Target public target;
    bool public onTransfer;       // arm on escrow -> x payouts (settle / withdraw) / 在托管付款时触发
    bool public onTransferFrom;   // arm on x -> escrow pulls (fund) / 在托管收款时触发
    bool public bubble;
    uint256 public fired;
    bool public lastOk;
    bytes public lastErr;

    // re-entrant settle arguments / 重入 settle 的参数
    address public sConsumer; address public sProvider; uint256 public sCumulative; uint64 public sExpires; bytes public sSig;
    address public ownProvider;   // the channel this token funds as a consumer / 代币作为消费者充值的通道

    function setEscrow(TapeAPIEscrow e) external { escrow = e; }
    function arm(Target t, bool onXfer, bool onXferFrom, bool bubble_) external {
        target = t; onTransfer = onXfer; onTransferFrom = onXferFrom; bubble = bubble_;
        fired = 0; lastOk = false; delete lastErr;
    }
    function setVoucher(address c, address p, uint256 cum, uint64 exp, bytes calldata sig) external {
        sConsumer = c; sProvider = p; sCumulative = cum; sExpires = exp; sSig = sig;
    }
    /// @dev Fund + request a withdraw on the token's own channel, un-armed / 未武装时为自身通道充值并请求提现
    function openOwnChannel(address provider, uint256 amt) external {
        Target t = target; target = Target.None;
        ownProvider = provider;
        balanceOf[address(this)] += amt;
        allowance[address(this)][address(escrow)] = type(uint256).max;
        escrow.fund(provider, amt);
        escrow.requestWithdraw(provider, amt);
        target = t;
    }

    function transfer(address to, uint256 amt) external override returns (bool) {
        _move(msg.sender, to, amt);
        if (onTransfer) _reenter();
        return true;
    }
    function transferFrom(address f, address to, uint256 amt) external override returns (bool) {
        allowance[f][msg.sender] -= amt;
        _move(f, to, amt);
        if (onTransferFrom) _reenter();
        return true;
    }

    function _reenter() internal {
        if (target == Target.None || fired != 0) return;   // one attempt per outer call / 每次外层调用只尝试一次
        fired++;
        bytes memory data;
        if (target == Target.Settle) {
            data = abi.encodeCall(TapeAPIEscrow.settle, (sConsumer, sProvider, sCumulative, sExpires, sSig));
        } else if (target == Target.Withdraw) {
            data = abi.encodeCall(TapeAPIEscrow.withdraw, (ownProvider));
        } else if (target == Target.Fund) {
            data = abi.encodeCall(TapeAPIEscrow.fund, (ownProvider, 1));
        } else if (target == Target.RequestWithdraw) {
            data = abi.encodeCall(TapeAPIEscrow.requestWithdraw, (ownProvider, 1));
        } else if (target == Target.CancelWithdraw) {
            data = abi.encodeCall(TapeAPIEscrow.cancelWithdraw, (ownProvider));
        } else {
            data = abi.encodeCall(TapeAPIEscrow.authorizeSession, (ownProvider, address(0xBEEF), uint64(block.timestamp + 1)));
        }
        (bool ok, bytes memory ret) = address(escrow).call(data);
        lastOk = ok;
        lastErr = ret;
        if (!ok && bubble) {
            assembly { revert(add(ret, 0x20), mload(ret)) }
        }
    }
}

/// @dev Returns `false` (and moves nothing) instead of reverting -- globally, or only toward one recipient so a
///      payout can fail halfway (e.g. provider leg ok, treasury leg false).
///      以返回 false 代替回滚（且不转账）——可全局，也可只针对某个收款人，让一次付款在半途失败。
contract Mal_FalseToken is Mal_ERC20 {
    bool public falseOnTransfer;
    bool public falseOnTransferFrom;
    address public falseTo;       // if set, only transfers to this address return false / 若设置，仅对该地址返回 false
    function setFalse(bool onXfer, bool onXferFrom, address onlyTo) external {
        falseOnTransfer = onXfer; falseOnTransferFrom = onXferFrom; falseTo = onlyTo;
    }
    function transfer(address to, uint256 amt) external override returns (bool) {
        if (falseOnTransfer && (falseTo == address(0) || falseTo == to)) return false;
        _move(msg.sender, to, amt);
        return true;
    }
    function transferFrom(address f, address to, uint256 amt) external override returns (bool) {
        if (falseOnTransferFrom) return false;
        allowance[f][msg.sender] -= amt;
        _move(f, to, amt);
        return true;
    }
}

/// @dev USDT-style: transfer / transferFrom return NOTHING, and revert on insufficient balance / allowance.
///      USDT 风格：无返回值，余额 / 额度不足时回滚。
contract Mal_NoReturnToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    function mint(address to, uint256 amt) external { balanceOf[to] += amt; }
    function approve(address s, uint256 amt) external { allowance[msg.sender][s] = amt; }
    function transfer(address to, uint256 amt) external { balanceOf[msg.sender] -= amt; balanceOf[to] += amt; }
    function transferFrom(address f, address to, uint256 amt) external {
        allowance[f][msg.sender] -= amt; balanceOf[f] -= amt; balanceOf[to] += amt;
    }
}

/// @dev Fee-on-transfer: `feeBps` of every move is burned to 0xdead. UNSUPPORTED by the escrow (BEM is fixed and is
///      not FoT); used to pin exactly how the solvency identity breaks.
///      转账收费代币：每次转账按 feeBps 烧到 0xdead。托管不支持（BEM 固定且非 FoT），用来钉住偿付恒等式如何被破坏。
contract Mal_FeeOnTransferToken is Mal_ERC20 {
    uint256 public immutable feeBps;
    constructor(uint256 feeBps_) { feeBps = feeBps_; }
    function feeOf(uint256 amt) public view returns (uint256) { return amt * feeBps / 10_000; }
    function _move(address f, address to, uint256 amt) internal override {
        uint256 fee = feeOf(amt);
        balanceOf[f] -= amt;
        balanceOf[to] += amt - fee;
        balanceOf[address(0xdead)] += fee;
    }
}
