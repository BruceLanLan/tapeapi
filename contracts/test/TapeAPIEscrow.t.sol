// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {TapeAPIEscrow} from "../src/TapeAPIEscrow.sol";
import {
    NotOwner, NotPendingOwner, ZeroAddress, ZeroAmount, NotHolder, ContributionTooHigh, Expired, BadSignature,
    NothingToSettle, InsufficientBalance, NoPendingWithdraw, CooldownActive, WithdrawWindowClosed, AmountTooLarge,
    TransferFailed, BadProvider, SessionTooLong, SessionShorteningNotSupported
} from "../src/interfaces.sol";

// ---------- Mocks / 测试替身 ----------

/// @dev Standard ERC-20 returning bool; counts transfer() calls so tests can prove "no transfer when 0".
///      标准返回 bool 的 ERC-20；统计 transfer() 次数以证明贡献为 0 时不发生转账。
contract MockERC20 {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    uint256 public transfers;
    function mint(address to, uint256 amt) external { balanceOf[to] += amt; }
    function approve(address s, uint256 amt) external returns (bool) { allowance[msg.sender][s] = amt; return true; }
    function transfer(address to, uint256 amt) external returns (bool) { transfers++; return _move(msg.sender, to, amt); }
    function transferFrom(address f, address to, uint256 amt) external returns (bool) {
        allowance[f][msg.sender] -= amt;
        return _move(f, to, amt);
    }
    function _move(address f, address to, uint256 amt) internal returns (bool) {
        balanceOf[f] -= amt; balanceOf[to] += amt; return true;
    }
}

/// @dev USDT-style token with no return values / 无返回值代币（USDT 风格）
contract MockERC20NoReturn {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    function mint(address to, uint256 amt) external { balanceOf[to] += amt; }
    function approve(address s, uint256 amt) external { allowance[msg.sender][s] = amt; }
    function transfer(address to, uint256 amt) external { balanceOf[msg.sender] -= amt; balanceOf[to] += amt; }
    function transferFrom(address f, address to, uint256 amt) external {
        allowance[f][msg.sender] -= amt; balanceOf[f] -= amt; balanceOf[to] += amt;
    }
}

/// @dev Token that returns false on transfer / 转账返回 false 的代币
contract MockERC20False {
    mapping(address => uint256) public balanceOf;
    function mint(address to, uint256 amt) external { balanceOf[to] += amt; }
    function approve(address, uint256) external pure returns (bool) { return true; }
    function transfer(address, uint256) external pure returns (bool) { return false; }
    function transferFrom(address, address, uint256) external pure returns (bool) { return false; }
}

contract MockERC721 {
    mapping(uint256 => address) public ownerOf;
    function mint(address to, uint256 id) external { ownerOf[id] = to; }
}

contract MockHub {
    /// @dev deterministic pseudo ERC-6551 address / 确定性伪容器地址
    function accountOf(address circuits, uint256 tokenId) external pure returns (address) {
        return address(uint160(uint256(keccak256(abi.encode("container", circuits, tokenId)))));
    }
}

// ---------- Tests ----------

contract TapeAPIEscrowTest is Test {
    MockERC20 bem;
    MockERC721 nft;
    MockHub hub;
    TapeAPIEscrow escrow;

    uint256 constant CONSUMER_PK = 0xC0FFEE;
    uint256 constant SESSION_PK = 0x5E55;
    uint256 constant STRANGER_PK = 0xBAD;
    uint256 constant HOLDER_PK = 0xA11CE;
    address consumer;
    address sessionKey;
    address stranger;
    address holder;                               // circuit holder / 电路持有人
    address provider;                             // = hub.accountOf(nft, TOKEN), the service container / 服务容器
    address provider2;                            // = hub.accountOf(nft, TOKEN2), a second, unrelated channel / 另一条通道
    address treasury = address(0x7EA5);
    uint256 constant TOKEN = 4246;
    uint256 constant TOKEN2 = 4247;
    uint256 constant MINTED = 10_000 ether;
    uint256 constant CHANNEL = 5_000 ether;       // funded toward `provider` in setUp / setUp 中充给 provider 的通道

    event Funded(address indexed consumer, address indexed provider, uint256 amount);
    event WithdrawRequested(address indexed consumer, address indexed provider, uint256 amount, uint64 availableAt);
    event Withdrawn(address indexed consumer, address indexed provider, uint256 amount);
    event WithdrawCancelled(address indexed consumer, address indexed provider);
    event SessionAuthorized(address indexed consumer, address indexed provider, address indexed key, uint64 expires);
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event Settled(address indexed consumer, address indexed provider, uint256 paid, uint256 contribution);
    event ContributionSet(address indexed provider, uint16 bps);
    event TreasuryChanged(address indexed oldTreasury, address indexed newTreasury);

    function setUp() public {
        consumer = vm.addr(CONSUMER_PK);
        sessionKey = vm.addr(SESSION_PK);
        stranger = vm.addr(STRANGER_PK);
        holder = vm.addr(HOLDER_PK);
        vm.warp(1_758_300_000);
        bem = new MockERC20();
        nft = new MockERC721();
        hub = new MockHub();
        nft.mint(holder, TOKEN);
        provider = hub.accountOf(address(nft), TOKEN);
        provider2 = hub.accountOf(address(nft), TOKEN2);
        escrow = new TapeAPIEscrow(address(bem), address(hub), treasury);
        bem.mint(consumer, MINTED);
        vm.startPrank(consumer);
        bem.approve(address(escrow), type(uint256).max);
        escrow.fund(provider, CHANNEL);
        vm.stopPrank();
    }

    // ----- helpers / 工具 -----

    function _sign(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _voucher(uint256 pk, uint256 cumulative, uint64 expires) internal view returns (bytes memory) {
        return _sign(pk, escrow.voucherDigest(consumer, provider, cumulative, expires));
    }

    function _voucherTo(uint256 pk, address p, uint256 cumulative, uint64 expires) internal view returns (bytes memory) {
        return _sign(pk, escrow.voucherDigest(consumer, p, cumulative, expires));
    }

    function _future() internal view returns (uint64) { return uint64(block.timestamp + 1 hours); }

    /// @dev holder opts in to `bps` for its own service / 持有人为自己的服务设置贡献比例
    function _setContribution(uint16 bps) internal {
        vm.prank(holder);
        escrow.setContribution(address(nft), TOKEN, bps);
    }

    // ----- constructor -----

    function test_constructor_zeroAddress_reverts() public {
        vm.expectRevert(ZeroAddress.selector);
        new TapeAPIEscrow(address(0), address(hub), treasury);
        vm.expectRevert(ZeroAddress.selector);
        new TapeAPIEscrow(address(bem), address(0), treasury);
        vm.expectRevert(ZeroAddress.selector);
        new TapeAPIEscrow(address(bem), address(hub), address(0));
    }

    function test_constructor_state() public {
        vm.expectEmit(true, true, false, true);
        emit TreasuryChanged(address(0), treasury);
        TapeAPIEscrow e = new TapeAPIEscrow(address(bem), address(hub), treasury);
        assertEq(address(e.bem()), address(bem));
        assertEq(address(e.hub()), address(hub));
        assertEq(e.treasury(), treasury);
        assertEq(e.owner(), address(this));
        assertEq(uint256(e.MAX_CONTRIBUTION_BPS()), 5000);
        assertEq(uint256(e.WITHDRAW_COOLDOWN()), 48 hours);
        assertEq(uint256(e.WITHDRAW_WINDOW()), 7 days);
        assertEq(uint256(e.MAX_SESSION()), 30 days);
        assertEq(uint256(e.contributionOf(provider)), 0); // default: no contribution / 默认不贡献
        assertEq(e.channelOf(consumer, provider), 0);
    }

    // ----- contribution: auth & cap / 贡献比例：权限与上限 -----

    function test_setContribution_holderOnly() public {
        vm.prank(stranger);
        vm.expectRevert(NotHolder.selector);
        escrow.setContribution(address(nft), TOKEN, 100);
        // escrow owner is not the holder either / 合约 owner 也无权
        vm.expectRevert(NotHolder.selector);
        escrow.setContribution(address(nft), TOKEN, 100);

        vm.prank(holder);
        vm.expectEmit(true, false, false, true);
        emit ContributionSet(provider, 100);
        escrow.setContribution(address(nft), TOKEN, 100);
        assertEq(uint256(escrow.contributionOf(provider)), 100);
    }

    function test_setContribution_cap() public {
        vm.prank(holder);
        vm.expectRevert(abi.encodeWithSelector(ContributionTooHigh.selector, uint16(5001)));
        escrow.setContribution(address(nft), TOKEN, 5001);
        _setContribution(5000);
        assertEq(uint256(escrow.contributionOf(provider)), 5000);
    }

    function test_setContribution_zeroDisables() public {
        _setContribution(250);
        _setContribution(0);
        assertEq(uint256(escrow.contributionOf(provider)), 0);
    }

    function test_setContribution_followsCircuitTransfer() public {
        nft.mint(stranger, TOKEN); // simulate transfer / 模拟转让
        vm.prank(holder);
        vm.expectRevert(NotHolder.selector);
        escrow.setContribution(address(nft), TOKEN, 100);
        vm.prank(stranger);
        escrow.setContribution(address(nft), TOKEN, 100);
        assertEq(uint256(escrow.contributionOf(provider)), 100);
    }

    function test_setContribution_unknownToken_reverts() public {
        vm.prank(holder);
        vm.expectRevert(NotHolder.selector); // ownerOf(999) == address(0) != holder
        escrow.setContribution(address(nft), 999, 100);
    }

    function test_setContribution_keyedByContainer_notByCaller() public {
        // holder of a second circuit sets its own bps; first service unaffected / 另一电路的持有人只影响自己的容器
        nft.mint(stranger, 7);
        address p7 = hub.accountOf(address(nft), 7);
        vm.prank(stranger);
        escrow.setContribution(address(nft), 7, 300);
        assertEq(uint256(escrow.contributionOf(p7)), 300);
        assertEq(uint256(escrow.contributionOf(provider)), 0);
    }

    // ----- fund / 充值通道 -----

    function test_fund() public {
        assertEq(escrow.channelOf(consumer, provider), CHANNEL);
        assertEq(bem.balanceOf(address(escrow)), CHANNEL);
        vm.prank(consumer);
        vm.expectEmit(true, true, false, true);
        emit Funded(consumer, provider, 1 ether);
        escrow.fund(provider, 1 ether);
        assertEq(escrow.channelOf(consumer, provider), CHANNEL + 1 ether, "funding accumulates");
        assertEq(bem.balanceOf(address(escrow)), CHANNEL + 1 ether);
    }

    function test_fund_zero_reverts() public {
        vm.prank(consumer);
        vm.expectRevert(ZeroAmount.selector);
        escrow.fund(provider, 0);
    }

    function test_fund_badProvider_reverts() public {
        vm.startPrank(consumer);
        vm.expectRevert(BadProvider.selector);
        escrow.fund(address(0), 1 ether);
        vm.expectRevert(BadProvider.selector);
        escrow.fund(address(escrow), 1 ether);
        vm.stopPrank();
        assertEq(bem.balanceOf(address(escrow)), CHANNEL, "nothing left the wallet");
    }

    function test_fund_withoutApproval_reverts() public {
        bem.mint(stranger, 1 ether);
        vm.prank(stranger);
        vm.expectRevert(); // mock underflows on allowance / 授权不足回滚
        escrow.fund(provider, 1 ether);
    }

    /// @dev The whole point of v2: money funded toward one provider is invisible to every other one.
    ///      v2 的全部要点：充给一个提供者的钱，其它任何提供者都看不见。
    function test_fund_channelsAreIsolated() public {
        vm.prank(consumer);
        escrow.fund(provider2, 700 ether);
        assertEq(escrow.channelOf(consumer, provider), CHANNEL, "provider's channel unchanged");
        assertEq(escrow.channelOf(consumer, provider2), 700 ether);
        assertEq(escrow.channelOf(stranger, provider), 0, "another consumer's channel is separate");
        assertEq(bem.balanceOf(address(escrow)), CHANNEL + 700 ether);
    }

    // ----- sessions / 会话密钥 -----

    function test_authorizeSession_basic_event() public {
        uint64 exp = uint64(block.timestamp + 1 days);
        vm.prank(consumer);
        vm.expectEmit(true, true, true, true);
        emit SessionAuthorized(consumer, provider, sessionKey, exp);
        escrow.authorizeSession(provider, sessionKey, exp);
        assertEq(escrow.sessionExpiry(consumer, provider, sessionKey), exp);
        assertEq(escrow.sessionExpiry(consumer, provider2, sessionKey), 0, "per channel: nothing on provider2");
        assertEq(escrow.sessionExpiry(stranger, provider, sessionKey), 0, "per consumer");
    }

    function test_authorizeSession_validation() public {
        uint64 nowTs = uint64(block.timestamp);
        vm.startPrank(consumer);
        vm.expectRevert(ZeroAddress.selector);
        escrow.authorizeSession(provider, address(0), nowTs + 1 days);
        vm.expectRevert(BadProvider.selector);
        escrow.authorizeSession(address(0), sessionKey, nowTs + 1 days);
        vm.expectRevert(BadProvider.selector);
        escrow.authorizeSession(address(escrow), sessionKey, nowTs + 1 days);
        vm.expectRevert(Expired.selector);
        escrow.authorizeSession(provider, sessionKey, nowTs);       // must be strictly in the future / 须严格位于未来
        vm.expectRevert(Expired.selector);
        escrow.authorizeSession(provider, sessionKey, 0);
        vm.expectRevert(abi.encodeWithSelector(SessionTooLong.selector, nowTs + 30 days));
        escrow.authorizeSession(provider, sessionKey, nowTs + 30 days + 1);
        escrow.authorizeSession(provider, sessionKey, nowTs + 30 days);  // exactly MAX_SESSION is allowed / 恰为上限可以
        vm.stopPrank();
        assertEq(escrow.sessionExpiry(consumer, provider, sessionKey), nowTs + 30 days);
    }

    /// @dev Extend-only and no revoke: a key is bounded by its expiry and by ONE channel, and simply lapses.
    ///      只可延长且无撤销：密钥以其到期时间与一条通道为界，自然失效。
    function test_authorizeSession_extendOnly_noRevoke() public {
        uint64 long = uint64(block.timestamp + 10 days);
        vm.startPrank(consumer);
        escrow.authorizeSession(provider, sessionKey, long);
        vm.expectRevert(SessionShorteningNotSupported.selector);
        escrow.authorizeSession(provider, sessionKey, uint64(block.timestamp + 1 hours));
        escrow.authorizeSession(provider, sessionKey, long);            // equal is a no-op re-authorisation / 等值允许
        escrow.authorizeSession(provider, sessionKey, long + 1 days);   // extending is fine / 延长可以
        vm.stopPrank();
        assertEq(escrow.sessionExpiry(consumer, provider, sessionKey), long + 1 days);
        // The only way down is time. / 唯一的缩短方式是时间流逝。
        vm.warp(long + 1 days + 1);
        uint64 exp = _future();
        bytes memory sig = _voucher(SESSION_PK, 1 ether, exp);
        vm.expectRevert(BadSignature.selector);
        escrow.settle(consumer, provider, 1 ether, exp, sig);
    }

    function test_authorizeSession_isPerChannel() public {
        vm.startPrank(consumer);
        escrow.authorizeSession(provider, sessionKey, uint64(block.timestamp + 1 days));
        escrow.fund(provider2, 100 ether);
        vm.stopPrank();
        uint64 exp = _future();
        // The key is live on provider's channel... / 密钥在 provider 通道上有效……
        escrow.settle(consumer, provider, 1 ether, exp, _voucher(SESSION_PK, 1 ether, exp));
        assertEq(escrow.claimedOf(consumer, provider), 1 ether);
        // ...and worthless on provider2's, even though that channel is funded. / ……在 provider2 通道上一文不值。
        bytes memory sig = _voucherTo(SESSION_PK, provider2, 1 ether, exp);
        vm.expectRevert(BadSignature.selector);
        escrow.settle(consumer, provider2, 1 ether, exp, sig);
        assertEq(escrow.channelOf(consumer, provider2), 100 ether);
    }

    // ----- EIP-712 -----

    function test_domainSeparator_andDigest_matchSpec() public view {
        bytes32 ds = keccak256(abi.encode(
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256("TapeAPIEscrow"), keccak256("1"), block.chainid, address(escrow)
        ));
        assertEq(escrow.DOMAIN_SEPARATOR(), ds);
        bytes32 th = keccak256("Voucher(address consumer,address provider,uint256 cumulative,uint64 expires)");
        assertEq(escrow.VOUCHER_TYPEHASH(), th);
        // TAP-22 §3.1 / §6 pin this value; v2 keeps it byte-for-byte / 规范固定值，v2 逐字节不变
        assertEq(th, 0x8e017cc56e9f2cb1f0fd1af4419f7c77b8d3f92099263f2b8aba4ba44cf50407);
        bytes32 expected = keccak256(abi.encodePacked("\x19\x01", ds,
            keccak256(abi.encode(th, consumer, provider, uint256(123), uint64(456)))));
        assertEq(escrow.voucherDigest(consumer, provider, 123, 456), expected);
    }

    function test_domainSeparator_rebuildsOnFork() public {
        bytes32 before = escrow.DOMAIN_SEPARATOR();
        vm.chainId(999);
        assertTrue(escrow.DOMAIN_SEPARATOR() != before, "fork must change the domain");
        vm.chainId(31337);
        assertEq(escrow.DOMAIN_SEPARATOR(), before);
    }

    // ----- settle math / 结算数学 -----

    function test_settle_defaultZeroContribution_noTreasuryTransfer() public {
        uint64 exp = _future();
        bytes memory sig = _voucher(CONSUMER_PK, 1_000 ether, exp);
        uint256 transfersBefore = bem.transfers();
        vm.expectEmit(true, true, false, true);
        emit Settled(consumer, provider, 1_000 ether, 0);
        vm.prank(stranger); // anyone can settle / 任何人可结算
        escrow.settle(consumer, provider, 1_000 ether, exp, sig);

        assertEq(bem.balanceOf(provider), 1_000 ether);
        assertEq(bem.balanceOf(treasury), 0);
        assertEq(bem.transfers() - transfersBefore, 1); // exactly one transfer: to provider / 只有一次转账
        assertEq(escrow.channelOf(consumer, provider), CHANNEL - 1_000 ether);
        assertEq(escrow.claimedOf(consumer, provider), 1_000 ether);
    }

    function test_settle_contributionSplit_100bps() public {
        _setContribution(100); // 1%
        uint64 exp = _future();
        uint256 transfersBefore = bem.transfers();
        vm.expectEmit(true, true, false, true);
        emit Settled(consumer, provider, 1_000 ether, 10 ether);
        escrow.settle(consumer, provider, 1_000 ether, exp, _voucher(CONSUMER_PK, 1_000 ether, exp));
        assertEq(bem.balanceOf(provider), 990 ether);
        assertEq(bem.balanceOf(treasury), 10 ether);
        assertEq(bem.transfers() - transfersBefore, 2);
    }

    function test_settle_monotonicCumulative() public {
        _setContribution(100);
        uint64 exp = _future();
        escrow.settle(consumer, provider, 1_000 ether, exp, _voucher(CONSUMER_PK, 1_000 ether, exp));
        // second voucher pays only the delta / 第二张凭证只付增量
        escrow.settle(consumer, provider, 1_500 ether, exp, _voucher(CONSUMER_PK, 1_500 ether, exp));
        assertEq(escrow.claimedOf(consumer, provider), 1_500 ether);
        assertEq(bem.balanceOf(provider), 1_500 ether * 99 / 100);
        assertEq(bem.balanceOf(treasury), 15 ether);
        // replay / 重放
        bytes memory sig1 = _voucher(CONSUMER_PK, 1_500 ether, exp); // hoisted: expectRevert must target settle / 提前算签名
        vm.expectRevert(NothingToSettle.selector);
        escrow.settle(consumer, provider, 1_500 ether, exp, sig1);
        // older voucher / 旧凭证
        bytes memory sig2 = _voucher(CONSUMER_PK, 1_000 ether, exp);
        vm.expectRevert(NothingToSettle.selector);
        escrow.settle(consumer, provider, 1_000 ether, exp, sig2);
    }

    function test_settle_contributionRounding_and_disable() public {
        _setContribution(100);
        uint64 exp = _future();
        uint256 t0 = bem.transfers();
        escrow.settle(consumer, provider, 99, exp, _voucher(CONSUMER_PK, 99, exp)); // 99 * 1% = 0.99 -> 0
        assertEq(bem.balanceOf(provider), 99);
        assertEq(bem.balanceOf(treasury), 0);
        assertEq(bem.transfers() - t0, 1); // rounding to 0 skips the treasury transfer / 取整为 0 时不转账
        _setContribution(0);
        escrow.settle(consumer, provider, 1_099, exp, _voucher(CONSUMER_PK, 1_099, exp));
        assertEq(bem.balanceOf(provider), 1_099);
        assertEq(bem.balanceOf(treasury), 0);
    }

    function test_settle_maxContribution() public {
        _setContribution(5000);
        uint64 exp = _future();
        escrow.settle(consumer, provider, 1_000 ether, exp, _voucher(CONSUMER_PK, 1_000 ether, exp));
        assertEq(bem.balanceOf(provider), 500 ether);
        assertEq(bem.balanceOf(treasury), 500 ether);
    }

    function test_settle_contributionAppliesPerSettlement_notRetroactively() public {
        uint64 exp = _future();
        escrow.settle(consumer, provider, 1_000 ether, exp, _voucher(CONSUMER_PK, 1_000 ether, exp)); // 0 bps
        _setContribution(1000); // 10% from now on / 之后 10%
        escrow.settle(consumer, provider, 1_200 ether, exp, _voucher(CONSUMER_PK, 1_200 ether, exp)); // delta 200
        assertEq(bem.balanceOf(provider), 1_000 ether + 180 ether);
        assertEq(bem.balanceOf(treasury), 20 ether);
    }

    function test_settle_contributionGoesToCurrentTreasury() public {
        _setContribution(100);
        address t2 = address(0x7EA6);
        escrow.setTreasury(t2);
        uint64 exp = _future();
        escrow.settle(consumer, provider, 1_000 ether, exp, _voucher(CONSUMER_PK, 1_000 ether, exp));
        assertEq(bem.balanceOf(t2), 10 ether);
        assertEq(bem.balanceOf(treasury), 0);
    }

    function test_settle_expiredVoucher_reverts() public {
        uint64 exp = uint64(block.timestamp + 10);
        bytes memory sig = _voucher(CONSUMER_PK, 1 ether, exp);
        vm.warp(exp + 1);
        vm.expectRevert(Expired.selector);
        escrow.settle(consumer, provider, 1 ether, exp, sig);
    }

    function test_settle_atExpiryBoundary_ok() public {
        uint64 exp = uint64(block.timestamp + 10);
        bytes memory sig = _voucher(CONSUMER_PK, 1 ether, exp);
        vm.warp(exp); // block.timestamp <= expires passes / 等于时仍有效
        escrow.settle(consumer, provider, 1 ether, exp, sig);
    }

    /// @dev Partial settlement is a legitimate credit flow in v2: the provider chose to serve beyond the channel.
    ///      The channel pays what it has, `claimed` advances by that, and the SAME voucher settles the rest later.
    ///      v2 中部分结算是合法的赊账流程：提供者选择服务超过通道余额。通道付出所有，`claimed` 随之推进，
    ///      同一张凭证稍后续结余额。
    function test_settle_partialSettlement_isCreditFlow() public {
        _setContribution(100); // 1%
        uint64 exp = uint64(block.timestamp + 2 days);
        bytes memory over = _voucher(CONSUMER_PK, CHANNEL + 1_000 ether, exp);

        vm.expectEmit(true, true, false, true);
        emit Settled(consumer, provider, CHANNEL, CHANNEL / 100);
        escrow.settle(consumer, provider, CHANNEL + 1_000 ether, exp, over);
        assertEq(escrow.claimedOf(consumer, provider), CHANNEL, "claimed advances by what was paid, not by cumulative");
        assertEq(escrow.channelOf(consumer, provider), 0);
        assertEq(bem.balanceOf(provider), CHANNEL * 99 / 100);
        assertEq(bem.balanceOf(treasury), CHANNEL / 100);

        // Empty channel: the remainder is not payable yet. / 通道已空：余额尚不可付。
        vm.expectRevert(InsufficientBalance.selector);
        escrow.settle(consumer, provider, CHANNEL + 1_000 ether, exp, over);

        // The consumer funds again; the same signature pays the remainder in full.
        // 消费者再充值；同一签名足额兑付剩余部分。
        vm.prank(consumer);
        escrow.fund(provider, 1_500 ether);
        vm.expectEmit(true, true, false, true);
        emit Settled(consumer, provider, 1_000 ether, 10 ether);
        escrow.settle(consumer, provider, CHANNEL + 1_000 ether, exp, over);
        assertEq(escrow.claimedOf(consumer, provider), CHANNEL + 1_000 ether);
        assertEq(escrow.channelOf(consumer, provider), 500 ether);
    }

    function test_settle_badProvider_reverts() public {
        uint64 exp = _future();
        bytes memory sigZero = _voucherTo(CONSUMER_PK, address(0), 1 ether, exp);
        vm.expectRevert(BadProvider.selector);
        escrow.settle(consumer, address(0), 1 ether, exp, sigZero);
        bytes memory sigSelf = _voucherTo(CONSUMER_PK, address(escrow), 1 ether, exp);
        vm.expectRevert(BadProvider.selector);
        escrow.settle(consumer, address(escrow), 1 ether, exp, sigSelf);
    }

    /// @dev A voucher toward provider2 cannot draw one wei from provider's channel. / 对 provider2 的凭证碰不到 provider 的通道。
    function test_settle_cannotDrawFromAnotherChannel() public {
        uint64 exp = _future();
        bytes memory sig = _voucherTo(CONSUMER_PK, provider2, 1 ether, exp);
        vm.expectRevert(InsufficientBalance.selector);
        escrow.settle(consumer, provider2, 1 ether, exp, sig);
        assertEq(escrow.channelOf(consumer, provider), CHANNEL, "provider's channel untouched");
        assertEq(escrow.claimedOf(consumer, provider2), 0);
    }

    function test_settle_badSignature_reverts() public {
        uint64 exp = _future();
        // stranger signs / 无关人签名
        bytes memory sig5 = _voucher(STRANGER_PK, 1 ether, exp);
        vm.expectRevert(BadSignature.selector);
        escrow.settle(consumer, provider, 1 ether, exp, sig5);
        // tampered cumulative / 篡改金额
        bytes memory sig = _voucher(CONSUMER_PK, 1 ether, exp);
        vm.expectRevert(BadSignature.selector);
        escrow.settle(consumer, provider, 2 ether, exp, sig);
        // malformed / 长度错误
        vm.expectRevert(BadSignature.selector);
        escrow.settle(consumer, provider, 1 ether, exp, hex"00");
    }

    function test_settle_acceptsV0or1() public {
        uint64 exp = _future();
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(CONSUMER_PK, escrow.voucherDigest(consumer, provider, 1 ether, exp));
        escrow.settle(consumer, provider, 1 ether, exp, abi.encodePacked(r, s, uint8(v - 27)));
        assertEq(escrow.claimedOf(consumer, provider), 1 ether);
    }

    // ----- session keys at settlement / 结算时的会话密钥 -----

    function test_settle_sessionKey_pass() public {
        uint64 exp = _future();
        vm.prank(consumer);
        escrow.authorizeSession(provider, sessionKey, uint64(block.timestamp + 1 days));
        escrow.settle(consumer, provider, 1 ether, exp, _voucher(SESSION_PK, 1 ether, exp));
        assertEq(bem.balanceOf(provider), 1 ether);
    }

    function test_settle_sessionKey_expired_reverts() public {
        uint64 sessionExp = uint64(block.timestamp + 100);
        vm.prank(consumer);
        escrow.authorizeSession(provider, sessionKey, sessionExp);
        vm.warp(sessionExp + 1);
        uint64 exp = _future();
        bytes memory sig6 = _voucher(SESSION_PK, 1 ether, exp);
        vm.expectRevert(BadSignature.selector);
        escrow.settle(consumer, provider, 1 ether, exp, sig6);
    }

    /// @dev H-01 rule, unchanged from v1: the session must be live AT SETTLEMENT, not outlive the voucher.
    ///      沿用 v1 的 H-01 规则：关键是结算时会话有效，而非会话寿命长过凭证。
    function test_settle_sessionKey_validAtSettlementNotBeyondVoucher() public {
        uint64 sessionExp = uint64(block.timestamp + 100);
        vm.prank(consumer);
        escrow.authorizeSession(provider, sessionKey, sessionExp);

        // A voucher outliving the session settles while the session is still live. / 寿命超过会话的凭证在会话有效时可结算。
        escrow.settle(consumer, provider, 1 ether, sessionExp + 1_000, _voucher(SESSION_PK, 1 ether, sessionExp + 1_000));
        assertEq(escrow.claimedOf(consumer, provider), 1 ether);
        // At the session's last second the key still works. / 会话最后一秒仍可用。
        vm.warp(sessionExp);
        escrow.settle(consumer, provider, 2 ether, sessionExp + 1_000, _voucher(SESSION_PK, 2 ether, sessionExp + 1_000));
        // Once the session has lapsed, the same key can settle nothing more. / 会话一旦过期，该密钥再也无法结算。
        vm.warp(sessionExp + 1);
        bytes memory later = _voucher(SESSION_PK, 3 ether, uint64(block.timestamp + 1 hours));
        vm.expectRevert(BadSignature.selector);
        escrow.settle(consumer, provider, 3 ether, uint64(block.timestamp + 1 hours), later);
    }

    function test_settle_sessionKey_otherConsumer_reverts() public {
        // session authorized by stranger cannot spend consumer's channel / 他人授权的会话密钥不能花消费者的通道
        vm.prank(stranger);
        escrow.authorizeSession(provider, sessionKey, uint64(block.timestamp + 1 days));
        uint64 exp = _future();
        bytes memory sig8 = _voucher(SESSION_PK, 1 ether, exp);
        vm.expectRevert(BadSignature.selector);
        escrow.settle(consumer, provider, 1 ether, exp, sig8);
    }

    // ----- withdraw: request, cooldown, window / 提现：请求、冷静期、窗口 -----

    function test_requestWithdraw_validation() public {
        vm.startPrank(consumer);
        vm.expectRevert(ZeroAmount.selector);
        escrow.requestWithdraw(provider, 0);
        vm.expectRevert(InsufficientBalance.selector);
        escrow.requestWithdraw(provider, CHANNEL + 1);
        vm.expectRevert(InsufficientBalance.selector);
        escrow.requestWithdraw(provider2, 1);            // no channel there / 那里没有通道
        escrow.requestWithdraw(provider, CHANNEL);       // the boundary is allowed / 边界值可以
        vm.stopPrank();
        (uint256 amt, uint64 at) = escrow.pendingWithdraw(consumer, provider);
        assertEq(amt, CHANNEL);
        assertEq(at, uint64(block.timestamp));
        (amt,) = escrow.pendingWithdraw(consumer, provider2);
        assertEq(amt, 0, "per channel");
    }

    function test_requestWithdraw_amountTooLarge_reverts() public {
        uint256 huge = uint256(type(uint192).max) + 1;
        bem.mint(consumer, huge);
        vm.startPrank(consumer);
        escrow.fund(provider, huge);
        vm.expectRevert(AmountTooLarge.selector);
        escrow.requestWithdraw(provider, huge);
        escrow.requestWithdraw(provider, type(uint192).max); // largest representable / 最大可表示值
        (uint256 amt,) = escrow.pendingWithdraw(consumer, provider);
        assertEq(amt, type(uint192).max);
        vm.stopPrank();
    }

    function test_withdraw_cooldown() public {
        uint64 t0 = uint64(block.timestamp);
        vm.prank(consumer);
        vm.expectEmit(true, true, false, true);
        emit WithdrawRequested(consumer, provider, 1_000 ether, t0 + 48 hours);
        escrow.requestWithdraw(provider, 1_000 ether);

        vm.warp(t0 + 48 hours - 1);
        vm.prank(consumer);
        vm.expectRevert(abi.encodeWithSelector(CooldownActive.selector, t0 + 48 hours));
        escrow.withdraw(provider);

        vm.warp(t0 + 48 hours);
        uint256 before = bem.balanceOf(consumer);
        vm.prank(consumer);
        vm.expectEmit(true, true, false, true);
        emit Withdrawn(consumer, provider, 1_000 ether);
        escrow.withdraw(provider);
        assertEq(bem.balanceOf(consumer) - before, 1_000 ether);
        assertEq(escrow.channelOf(consumer, provider), CHANNEL - 1_000 ether);
        (uint256 amt,) = escrow.pendingWithdraw(consumer, provider);
        assertEq(amt, 0, "request cleared");
        // second withdraw needs a new request / 再次提现需重新请求
        vm.prank(consumer);
        vm.expectRevert(NoPendingWithdraw.selector);
        escrow.withdraw(provider);
    }

    function test_withdraw_window_openAtBoundaries_closedAfter() public {
        vm.prank(consumer);
        escrow.requestWithdraw(provider, 100);
        (, uint64 reqAt) = escrow.pendingWithdraw(consumer, provider);
        // last second of the window / 窗口最后一秒
        vm.warp(reqAt + 48 hours + 7 days);
        vm.prank(consumer);
        escrow.withdraw(provider);
        assertEq(escrow.channelOf(consumer, provider), CHANNEL - 100);

        vm.prank(consumer);
        escrow.requestWithdraw(provider, 100);
        (, reqAt) = escrow.pendingWithdraw(consumer, provider);
        vm.warp(reqAt + 48 hours + 7 days + 1);
        vm.prank(consumer);
        vm.expectRevert(WithdrawWindowClosed.selector);
        escrow.withdraw(provider);
        // stale request stays on record but is unusable; re-request restarts the cooldown / 陈旧请求不可用，需重新请求
        (uint256 amt,) = escrow.pendingWithdraw(consumer, provider);
        assertEq(amt, 100);
        vm.prank(consumer);
        escrow.requestWithdraw(provider, 100);
        vm.prank(consumer);
        vm.expectRevert(abi.encodeWithSelector(CooldownActive.selector, uint64(block.timestamp + 48 hours)));
        escrow.withdraw(provider);
        vm.warp(block.timestamp + 48 hours);
        vm.prank(consumer);
        escrow.withdraw(provider);
        assertEq(escrow.channelOf(consumer, provider), CHANNEL - 200);
    }

    function test_requestWithdraw_replacesAndResetsTimer() public {
        vm.prank(consumer);
        escrow.requestWithdraw(provider, 100);
        vm.warp(block.timestamp + 40 hours);
        vm.prank(consumer);
        escrow.requestWithdraw(provider, 200); // resets cooldown / 重置冷却
        vm.warp(block.timestamp + 10 hours); // 50h since first, 10h since second
        vm.prank(consumer);
        vm.expectRevert(abi.encodeWithSelector(CooldownActive.selector, uint64(block.timestamp + 38 hours)));
        escrow.withdraw(provider);
        (uint256 amt,) = escrow.pendingWithdraw(consumer, provider);
        assertEq(amt, 200, "the newer request replaced the older one");
    }

    /// @dev A settlement inside the cooldown comes first: withdraw pays min(requested, channel).
    ///      冷静期内的结算优先：提现支付 min(所请求, 通道余额)。
    function test_withdraw_paysMinOfRequestAndChannel_afterSettle() public {
        vm.prank(consumer);
        escrow.requestWithdraw(provider, CHANNEL);
        uint64 exp = uint64(block.timestamp + 3 days);
        escrow.settle(consumer, provider, 4_000 ether, exp, _voucher(CONSUMER_PK, 4_000 ether, exp));
        assertEq(escrow.channelOf(consumer, provider), 1_000 ether);

        vm.warp(block.timestamp + 48 hours);
        uint256 before = bem.balanceOf(consumer);
        vm.prank(consumer);
        vm.expectEmit(true, true, false, true);
        emit Withdrawn(consumer, provider, 1_000 ether);
        escrow.withdraw(provider);
        assertEq(bem.balanceOf(consumer) - before, 1_000 ether, "only what the settlement left");
        assertEq(escrow.channelOf(consumer, provider), 0);
        assertEq(bem.balanceOf(provider), 4_000 ether, "the provider that settled in time was paid in full");
    }

    function test_withdraw_channelDrained_reverts_requestSurvives() public {
        vm.prank(consumer);
        escrow.requestWithdraw(provider, CHANNEL);
        uint64 exp = uint64(block.timestamp + 3 days);
        escrow.settle(consumer, provider, CHANNEL, exp, _voucher(CONSUMER_PK, CHANNEL, exp));
        vm.warp(block.timestamp + 48 hours);
        vm.prank(consumer);
        vm.expectRevert(InsufficientBalance.selector);
        escrow.withdraw(provider);
        (uint256 amt,) = escrow.pendingWithdraw(consumer, provider);
        assertEq(amt, CHANNEL, "the revert leaves the request in place");
    }

    function test_withdraw_isPerChannel() public {
        vm.startPrank(consumer);
        escrow.fund(provider2, 300 ether);
        escrow.requestWithdraw(provider, 100 ether);
        vm.stopPrank();
        vm.warp(block.timestamp + 48 hours);
        vm.prank(consumer);
        vm.expectRevert(NoPendingWithdraw.selector);
        escrow.withdraw(provider2);                       // no request on that channel / 那条通道没有请求
        vm.prank(consumer);
        escrow.withdraw(provider);
        assertEq(escrow.channelOf(consumer, provider), CHANNEL - 100 ether);
        assertEq(escrow.channelOf(consumer, provider2), 300 ether, "the other channel is untouched");
    }

    // ----- admin: treasury only / 管理：仅金库 -----

    function test_setTreasury_onlyOwner_emits_nonZero() public {
        address t2 = address(0x7EA6);
        vm.expectEmit(true, true, false, true);
        emit TreasuryChanged(treasury, t2);
        escrow.setTreasury(t2);
        assertEq(escrow.treasury(), t2);
        vm.prank(stranger);
        vm.expectRevert(NotOwner.selector);
        escrow.setTreasury(stranger);
        vm.expectRevert(ZeroAddress.selector);
        escrow.setTreasury(address(0));
    }

    // ----- E-07: two-step ownership / 两步所有权转移 -----

    function test_transferOwnership_twoStep() public {
        vm.expectRevert(ZeroAddress.selector);
        escrow.transferOwnership(address(0));
        vm.prank(stranger);
        vm.expectRevert(NotOwner.selector);
        escrow.transferOwnership(stranger);

        vm.expectEmit(true, true, false, true);
        emit OwnershipTransferStarted(address(this), stranger);
        escrow.transferOwnership(stranger);
        assertEq(escrow.owner(), address(this));   // unchanged until accepted / 接受前不变
        assertEq(escrow.pendingOwner(), stranger);
        vm.prank(stranger);
        vm.expectRevert(NotOwner.selector);
        escrow.setTreasury(address(0x7EA6));      // nominee has no power yet / 被提名者尚无权限
        vm.prank(holder);
        vm.expectRevert(NotPendingOwner.selector);
        escrow.acceptOwnership();                  // only the nominee may accept / 只有被提名者能接受
        escrow.setTreasury(address(0x7EA7));      // current owner still in control / 现任 owner 仍可操作

        vm.prank(stranger);
        vm.expectEmit(true, true, false, true);
        emit OwnershipTransferred(address(this), stranger);
        escrow.acceptOwnership();
        assertEq(escrow.owner(), stranger);
        assertEq(escrow.pendingOwner(), address(0));
        vm.expectRevert(NotOwner.selector);
        escrow.setTreasury(address(0x7EA6));
        vm.prank(stranger);
        escrow.setTreasury(address(0x7EA6));
        assertEq(escrow.treasury(), address(0x7EA6));
        // a second accept is rejected / 再次接受被拒
        vm.prank(stranger);
        vm.expectRevert(NotPendingOwner.selector);
        escrow.acceptOwnership();
    }

    function test_transferOwnership_renominateReplacesPending() public {
        escrow.transferOwnership(stranger);
        escrow.transferOwnership(holder); // replaces the nominee / 覆盖提名
        assertEq(escrow.pendingOwner(), holder);
        vm.prank(stranger);
        vm.expectRevert(NotPendingOwner.selector);
        escrow.acceptOwnership();
        escrow.transferOwnership(address(this)); // nominating yourself: effectively a cancel / 提名自己等于取消
        escrow.acceptOwnership();
        assertEq(escrow.owner(), address(this));
        assertEq(escrow.pendingOwner(), address(0));
    }

    // ----- token compatibility / 代币兼容 -----

    function test_noReturnToken_works() public {
        MockERC20NoReturn t = new MockERC20NoReturn();
        TapeAPIEscrow e = new TapeAPIEscrow(address(t), address(hub), treasury);
        vm.prank(holder);
        e.setContribution(address(nft), TOKEN, 100);
        t.mint(consumer, 1_000);
        vm.startPrank(consumer);
        t.approve(address(e), 1_000);
        e.fund(provider, 1_000);
        vm.stopPrank();
        uint64 exp = _future();
        bytes memory sig = _sign(CONSUMER_PK, e.voucherDigest(consumer, provider, 500, exp));
        e.settle(consumer, provider, 500, exp, sig);
        assertEq(t.balanceOf(provider), 495);
        assertEq(t.balanceOf(treasury), 5);
        vm.prank(consumer);
        e.requestWithdraw(provider, 500);
        vm.warp(block.timestamp + 48 hours);
        vm.prank(consumer);
        e.withdraw(provider);
        assertEq(t.balanceOf(consumer), 500);
    }

    function test_falseReturningToken_reverts() public {
        MockERC20False t = new MockERC20False();
        TapeAPIEscrow e = new TapeAPIEscrow(address(t), address(hub), treasury);
        vm.prank(consumer);
        vm.expectRevert(TransferFailed.selector);
        e.fund(provider, 1);
    }
    /// @dev cancelWithdraw removes a pending request; only the requester's own; no-op-guarded.
    ///      cancelWithdraw 撤回待处理请求；只能撤自己的；无请求时回滚。
    function test_cancelWithdraw() public {
        vm.startPrank(consumer);
        escrow.fund(provider, 100 ether);
        uint256 before = escrow.channelOf(consumer, provider);
        escrow.requestWithdraw(provider, 40 ether);
        (uint256 amt,) = escrow.pendingWithdraw(consumer, provider);
        assertEq(amt, 40 ether);
        vm.expectEmit(true, true, false, false);
        emit WithdrawCancelled(consumer, provider);
        escrow.cancelWithdraw(provider);
        (amt,) = escrow.pendingWithdraw(consumer, provider);
        assertEq(amt, 0, "request cleared");
        vm.expectRevert(NoPendingWithdraw.selector);
        escrow.cancelWithdraw(provider);
        // and withdraw() has nothing to execute / 已无可执行的请求
        vm.warp(block.timestamp + 49 hours);
        vm.expectRevert(NoPendingWithdraw.selector);
        escrow.withdraw(provider);
        vm.stopPrank();
        assertEq(escrow.channelOf(consumer, provider), before, "funds untouched");
    }

}
