// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// ============================================================================================
// Attacker-perspective regression tests / 攻击者视角回归测试
//
// Escrow half: every attack from docs/REVIEW-CONTRACTS.md (v0.2), docs/AUDIT-predeploy.md (round 1),
// docs/AUDIT-predeploy-round2.md and docs/AUDIT-signoff.md, replayed against the v2 per-channel escrow
// (docs/DECISION-escrow-v2.md). The v1 version of this file is archived verbatim as
// contracts/archive/Attacks.v1.t.sol.txt. Directory half: unchanged from v1.
// Each test sets up the reviewer's exact preconditions, runs the attack sequence, and asserts the attack
// FAILS (specific revert) or that the economic invariant it targeted holds; where v2 makes the attack
// inexpressible, the test shows the closest thing the attacker can still do and asserts it gains nothing.
// Every test also exercises the non-adversarial twin of the same path, so a green result cannot come
// from a broken setup.
//
// 托管部分：三轮审计与 v0.2 评审中的每个攻击都按原始序列对 v2 重放（v1 版本原样归档于
// contracts/archive/Attacks.v1.t.sol.txt）；目录部分与 v1 相同。每个测试复现评审描述的前置条件与攻击
// 序列，断言攻击失败或其针对的经济不变量依然成立；攻击在 v2 中无法表达时，展示攻击者仍能做的最接近
// 的事并断言一无所获；同时覆盖对应的正常路径，避免"因环境搭错而变绿"。
// ============================================================================================

import "forge-std/Test.sol";
import {TapeAPIEscrow} from "../src/TapeAPIEscrow.sol";
import {ServiceDirectory} from "../src/ServiceDirectory.sol";
import {
    Service, BadSignature, InsufficientBalance, CooldownActive, WithdrawWindowClosed, NoPendingWithdraw,
    BadProvider, Expired, NothingToSettle, SessionShorteningNotSupported, SessionTooLong,
    NotCPU, NotHolder, NotLive, ServiceNotFound
} from "../src/interfaces.sol";

// ---------- Mocks (Atk_ prefixed to stay independent of the other test files) ----------
// ---------- 测试替身（加 Atk_ 前缀，避免与其它测试文件冲突，本文件自包含）----------

contract Atk_MockERC20 {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    function mint(address to, uint256 amt) external { balanceOf[to] += amt; }
    function approve(address s, uint256 amt) external returns (bool) { allowance[msg.sender][s] = amt; return true; }
    function transfer(address to, uint256 amt) external returns (bool) { return _move(msg.sender, to, amt); }
    function transferFrom(address f, address to, uint256 amt) external returns (bool) {
        allowance[f][msg.sender] -= amt;
        return _move(f, to, amt);
    }
    function _move(address f, address to, uint256 amt) internal returns (bool) {
        balanceOf[f] -= amt; balanceOf[to] += amt; return true;
    }
}

/// @dev Lenient ERC-721: unknown tokens resolve to address(0) / 宽松实现：未知 token 返回零地址
contract Atk_MockERC721 {
    mapping(uint256 => address) public ownerOf;
    function mint(address to, uint256 id) external { ownerOf[id] = to; }
}

/// @dev OpenZeppelin-style ERC-721: `ownerOf` REVERTS for burned / non-existent tokens (D-02)
///      OZ 风格：已销毁 / 不存在的 token 调用 `ownerOf` 直接回滚
contract Atk_MockERC721Strict {
    mapping(uint256 => address) private _owners;
    function mint(address to, uint256 id) external { _owners[id] = to; }
    function burn(uint256 id) external { delete _owners[id]; }
    function ownerOf(uint256 id) external view returns (address o) {
        o = _owners[id];
        require(o != address(0), "ERC721: invalid token ID");
    }
}

/// @dev The attacker's home-made ERC-721: `ownerOf` says whatever the attacker wants (D-01)
///      攻击者自制的假 ERC-721：`ownerOf` 恒返回攻击者指定地址
contract Atk_FakeCircuits {
    address public puppet;
    constructor(address puppet_) { puppet = puppet_; }
    function ownerOf(uint256) external view returns (address) { return puppet; }
}

contract Atk_MockFactory {
    mapping(address => bool) public isCPU;
    function set(address circuits, bool v) external { isCPU[circuits] = v; }
}

contract Atk_MockHub {
    function accountOf(address circuits, uint256 tokenId) external pure returns (address) {
        return address(uint160(uint256(keccak256(abi.encode("container", circuits, tokenId)))));
    }
}

/// @dev DomainBinding returning arbitrary raw bytes (non-canonical bool, short data) / 返回任意原始字节
/// @dev A gate that floods returndata. Before SD-01 the directory copied all of it and ran out of gas.
///      返回海量数据的门槛合约。SD-01 修复前，目录会全量回拷并耗尽 gas。
contract Atk_DomainBindingBomb {
    uint256 public words;
    function setWords(uint256 n) external { words = n; }
    fallback() external {
        uint256 n = words;
        assembly {
            let size := mul(n, 32)
            let p := mload(0x40)
            mstore(p, 1)                 // a valid `true` in the first word / 首字是合法的 true
            return(p, size)
        }
    }
}

contract Atk_DomainBindingRaw {
    bytes public ret;
    function setRet(bytes calldata r) external { ret = r; }
    fallback() external {
        bytes memory r = ret;
        assembly { return(add(r, 32), mload(r)) }
    }
}

/// @dev DomainBinding that always reverts / 恒回滚的 DomainBinding
contract Atk_DomainBindingRevert {
    function isContainerLive(address) external pure returns (bool) {
        revert("DomainBinding: boom");
    }
}

// ============================================================================================
//                                   ESCROW ATTACKS (v2 channels)
//
// Every attack anyone found against the v1 escrow (docs/AUDIT-predeploy.md, docs/AUDIT-predeploy-round2.md,
// docs/AUDIT-signoff.md, and the archived contracts/archive/Attacks.v1.t.sol.txt) is run here in the attacker's
// exact sequence against the v2 per-channel design. The reviewer's scenario text is kept verbatim in the
// comment above each test. Outcomes are one of three, stated in each test's header:
//   INEXPRESSIBLE  -- the attack's first step has no v2 equivalent; the test shows the closest thing the
//                     attacker can still do and asserts it gains nothing;
//   SAME GUARANTEE -- v2 gives exactly the guarantee v1 gave, no more (E-03: the provider must act inside a
//                     public window), and the test asserts both halves of it plainly;
//   STILL DEFENDED -- the v1 defence carries over unchanged (M-01, R-01, H-01 rule, ...).
// The resync drain (docs/REVIEW-SDK*.md) is SDK-side and lives in sdk/test/flow.test.mjs.
//
// v1 托管的三轮审计与旧攻击测试中的每个攻击，都在此按攻击者的原始序列对 v2 重放。评审原文保留在注释中。
// 结论三选一：无法表达 / 与 v1 相同的保证（E-03，诚实记录的取舍）/ 防御原样保留。
// ============================================================================================

contract EscrowAttacksTest is Test {
    Atk_MockERC20 bem;
    Atk_MockERC721 nft;
    Atk_MockHub hub;
    TapeAPIEscrow escrow;

    uint256 constant CONSUMER_PK = 0xC0FFEE;
    uint256 constant SESSION_PK = 0x5E55;

    address consumer;
    address sessionKey;
    address provider;   // container of TOKEN1 / 第一个服务容器
    address provider2;  // container of TOKEN2 / 第二个服务容器
    address treasury = address(0x7EA5);
    address stranger = address(0x57A2);   // any third party / 任意第三方

    uint256 constant TOKEN1 = 4246;
    uint256 constant TOKEN2 = 4247;
    uint256 constant CHANNEL = 1_000 ether;   // funded toward `provider` in setUp / setUp 中充给 provider 的通道

    function setUp() public {
        vm.warp(1_758_300_000); // leave room beneath for 48h/7d arithmetic / 为 48h/7d 运算留出时间余量
        consumer = vm.addr(CONSUMER_PK);
        sessionKey = vm.addr(SESSION_PK);

        bem = new Atk_MockERC20();
        nft = new Atk_MockERC721();
        hub = new Atk_MockHub();
        escrow = new TapeAPIEscrow(address(bem), address(hub), treasury);

        provider = hub.accountOf(address(nft), TOKEN1);
        provider2 = hub.accountOf(address(nft), TOKEN2);

        bem.mint(consumer, 10_000 ether); // extra for top-ups and second channels / 额外用于补充与第二条通道
        vm.startPrank(consumer);
        bem.approve(address(escrow), type(uint256).max);
        escrow.fund(provider, CHANNEL);
        vm.stopPrank();

        // These tests replay channel mechanics, where "paid in full" means the whole amount: the providers opt out of the
        // TAPI-22 §3.4 default contribution (1%) here. The contribution split, the default included, has its own tests in
        // TapeAPIEscrow.t.sol, and EscrowInvariant.t.sol starts every provider at the default.
        // 这些测试重放通道机制，"足额"指全额：此处让提供者关闭 TAPI-22 §3.4 的默认贡献（1%）。贡献拆分（含默认值）
        // 另有测试（TapeAPIEscrow.t.sol），EscrowInvariant.t.sol 让每个提供者从默认值开始。
        address opHolder = vm.addr(0x0F0F);
        nft.mint(opHolder, TOKEN1);
        nft.mint(opHolder, TOKEN2);
        vm.startPrank(opHolder);
        escrow.setContribution(address(nft), TOKEN1, 0);
        escrow.setContribution(address(nft), TOKEN2, 0);
        vm.stopPrank();
    }

    // ----- helpers / 工具 -----

    function _sign(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _voucher(uint256 pk, address p, uint256 cumulative, uint64 expires) internal view returns (bytes memory) {
        return _sign(pk, escrow.voucherDigest(consumer, p, cumulative, expires));
    }

    function _voucherAs(uint256 pk, address c, address p, uint256 cumulative, uint64 expires)
        internal view returns (bytes memory)
    {
        return _sign(pk, escrow.voucherDigest(c, p, cumulative, expires));
    }

    /// @dev A consumer with a funded channel toward `provider` / 已向 provider 充值通道的消费者
    function _newConsumer(uint256 pk, uint256 amount) internal returns (address c) {
        c = vm.addr(pk);
        bem.mint(c, amount * 3); // headroom for top-ups / 预留补充余额的额度
        vm.startPrank(c);
        bem.approve(address(escrow), type(uint256).max);
        escrow.fund(provider, amount);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------------------------
    // E-01 (High) — "消费者用主密钥正常签凭证消费；看到 provider 的 `settle` 进入 mempool 后以更高 gas
    //   发 `setAllowance(provider, 0)`（BSC 3s 出块，脚本可行），`settle` 回滚 `OverAllowance`；随后
    //   `requestWithdraw` → 24h → `withdraw` 拿回全部余额。TAP-22 §8 把 24h 延迟当作 provider 的唯一
    //   保护，但此路径完全绕过它 —— provider 监听 `WithdrawRequested` 也无济于事，因为整个窗口内
    //   `settle` 都会回滚。PoC-2、PoC-3 已复现。"
    //
    // v2: INEXPRESSIBLE. There is no allowance to zero. The ONLY consumer action that can ever shrink what a
    // provider settles is `requestWithdraw`, and it does nothing for 48h. The closest the attacker can do in the
    // settle block is fire that request; the settle in the same block still pays in full, `withdraw` reverts
    // CooldownActive, and after the cooldown only the unspent remainder can leave.
    // v2：无法表达。没有额度可清零；消费者唯一能缩小 provider 可结算额的操作是 `requestWithdraw`，48h 内无效。
    // ------------------------------------------------------------------------------------
    function test_attack_E01_frontRunSettle_noInstantShrinkExists() public {
        // Preconditions: consumer bursts N paid calls inside the channel / 前置：消费者在通道内连续消费 N 次
        uint64 expires = uint64(block.timestamp + 1 hours);
        bytes memory sig;
        uint256 cumulative;
        for (uint256 i = 1; i <= 3; i++) {
            cumulative = 100 ether * i;
            sig = _voucher(CONSUMER_PK, provider, cumulative, expires);
        }
        assertEq(cumulative, 300 ether);

        // Attack: the only shrinking action, fired in the settle's block with more gas.
        // 攻击：在结算所在区块、以更高 gas 发出唯一的缩减操作。
        vm.prank(consumer);
        escrow.requestWithdraw(provider, CHANNEL);
        assertEq(escrow.channelOf(consumer, provider), CHANNEL, "a request moves nothing");
        uint64 availableAt = uint64(block.timestamp) + escrow.WITHDRAW_COOLDOWN(); // hoisted: a view call would eat the prank / 提前算，避免 view 调用吃掉 prank
        vm.prank(consumer);
        vm.expectRevert(abi.encodeWithSelector(CooldownActive.selector, availableAt));
        escrow.withdraw(provider);

        // Provider settles in the very same block: paid in full. / provider 在同一区块结算：足额收款。
        escrow.settle(consumer, provider, cumulative, expires, sig);
        assertEq(bem.balanceOf(provider), 300 ether, "provider must still be able to settle");
        assertEq(escrow.claimedOf(consumer, provider), 300 ether);

        // Non-adversarial twin: after the cooldown the consumer recovers only what was never settled.
        // 正常路径：冷静期后消费者只能拿回未被结算的部分。
        vm.warp(block.timestamp + escrow.WITHDRAW_COOLDOWN());
        vm.prank(consumer);
        escrow.withdraw(provider);
        assertEq(escrow.channelOf(consumer, provider), 0);
        assertEq(bem.balanceOf(provider), 300 ether, "settled money never comes back");
    }

    // ------------------------------------------------------------------------------------
    // E-02 (High) — "消费者（或其前端）用 session key 消费一整天，再发一笔 `revokeSession(key)`
    //   （无冷却、无事件前置），provider 手中所有凭证在 `settle` 时命中 `BadSignature`。与 E-01 一样
    //   绕过 24h 保护。非恶意场景：provider 若在 `sessionExpiry` 之后才结算同样颗粒无收。PoC-4 已复现。"
    //
    // v2: INEXPRESSIBLE. There is no `revokeSession`. `authorizeSession` is extend-only, so the closest the
    // attacker can do -- re-authorise the key with a shorter or zero expiry -- reverts by name, and the
    // provider settles everything the key signed. The non-malicious half (a provider that waits past the
    // key's natural expiry gets nothing) is the same H-01 live-at-settlement rule as v1 and is asserted too.
    // v2：无法表达。没有 `revokeSession`；`authorizeSession` 只可延长，缩短或清零都以具名错误拒绝。
    // ------------------------------------------------------------------------------------
    function test_attack_E02_revokeSessionAfterSigning_noRevokeExists() public {
        uint64 sessionExp = uint64(block.timestamp + 7 days);
        vm.prank(consumer);
        escrow.authorizeSession(provider, sessionKey, sessionExp);

        // Preconditions: a day of consumption signed by the session key / 前置：会话密钥签发一天的消费
        uint64 expires = uint64(block.timestamp + 12 hours);
        bytes memory sig = _voucher(SESSION_PK, provider, 200 ether, expires);

        // Attack: "revoke" the key immediately after signing. Every spelling of it is refused.
        // 攻击：签完立刻"撤销"密钥。每一种写法都被拒绝。
        vm.startPrank(consumer);
        vm.expectRevert(SessionShorteningNotSupported.selector);
        escrow.authorizeSession(provider, sessionKey, uint64(block.timestamp + 1));
        vm.expectRevert(Expired.selector);
        escrow.authorizeSession(provider, sessionKey, 0);
        vm.expectRevert(Expired.selector);
        escrow.authorizeSession(provider, sessionKey, uint64(block.timestamp));
        vm.stopPrank();
        assertEq(escrow.sessionExpiry(consumer, provider, sessionKey), sessionExp, "the key's expiry is untouched");

        // Attack fails: the provider settles and is paid in full. / 攻击失败：provider 足额收款。
        escrow.settle(consumer, provider, 200 ether, expires, sig);
        assertEq(bem.balanceOf(provider), 200 ether, "provider must still settle; nothing can revoke the key");

        // H-01 rule (unchanged): a voucher dated beyond the session settles while the session is live, and the
        // key settles nothing once it has lapsed. 会话有效期内可结算超期凭证；会话过期后该密钥一无所获。
        uint64 beyond = sessionExp + 1;
        escrow.settle(consumer, provider, 250 ether, beyond, _voucher(SESSION_PK, provider, 250 ether, beyond));
        vm.warp(sessionExp + 1);
        bytes memory sigAfter = _voucher(SESSION_PK, provider, 300 ether, uint64(block.timestamp + 1 hours));
        vm.expectRevert(BadSignature.selector);
        escrow.settle(consumer, provider, 300 ether, uint64(block.timestamp + 1 hours), sigAfter);
    }

    // ------------------------------------------------------------------------------------
    // E-03 (High) — "消费者充值后立刻 `requestWithdraw(全额)`，等 24h（期间不消费或少量消费），之后照常
    //   消费数日；需要赖账时在 provider 的 `settle` 同一区块抢跑 `withdraw()`，全额取出，`settle` 命中
    //   `InsufficientBalance`。PoC-1 已复现。"
    //
    // v2: SAME GUARANTEE AS v1 -- this is the honest trade recorded in docs/DECISION-escrow-v2.md, stated
    // plainly. In v1 the consumer could not arm a withdraw while an allowance stood, but it could
    // `requestAllowanceDecrease(P, 0)`: a public event after which a provider that did not settle within 24h had
    // its vouchers clamped to nothing. In v2 the consumer can arm the withdraw at once: a public
    // `WithdrawRequested` after which a provider that does not settle within 48h is not paid. Both designs are
    // "a public event plus a fixed window in which the provider MUST act". So:
    //   (a) the provider that settles inside the cooldown is paid in full and the consumer recovers only the rest;
    //   (b) the provider that serves against an executable request and settles late is NOT paid -- and TAP-22
    //       §3.2(4) therefore tells the reference provider to treat an armed request as unavailable balance.
    // v2：与 v1 相同的保证——决策中诚实记录的取舍。v1 的 `requestAllowanceDecrease` 与 v2 的 `WithdrawRequested`
    // 都是"公开事件 + 提供者必须在固定窗口内行动"。(a) 冷静期内结算的提供者足额收款；(b) 不结算的提供者拿不到。
    // ------------------------------------------------------------------------------------
    function test_attack_E03_prearmedWithdraw_providerThatSettlesInsideCooldownIsPaid() public {
        // Attack step 1: fund(1000) then immediately requestWithdraw(1000). Allowed in v2.
        // 攻击第一步：充值后立刻对全额上膛。v2 允许。
        uint64 t0 = uint64(block.timestamp);
        vm.prank(consumer);
        escrow.requestWithdraw(provider, CHANNEL);
        (uint256 armed, uint64 requestedAt) = escrow.pendingWithdraw(consumer, provider);
        assertEq(armed, CHANNEL);
        assertEq(requestedAt, t0);
        uint64 availableAt = t0 + escrow.WITHDRAW_COOLDOWN();

        // The provider watches WithdrawRequested. It serves 800 worth INSIDE the cooldown and settles before
        // `availableAt` -- that is the whole of its protection, and it is enough.
        // provider 监听 WithdrawRequested，在冷静期内提供 800 的服务并在 `availableAt` 前结算——这就是它的全部
        // 保护，且足够。
        vm.warp(t0 + 6 hours);
        uint64 expires = uint64(block.timestamp + 1 hours);
        bytes memory sig = _voucher(CONSUMER_PK, provider, 800 ether, expires);
        vm.prank(consumer);
        vm.expectRevert(abi.encodeWithSelector(CooldownActive.selector, availableAt));
        escrow.withdraw(provider);                       // nothing can be pulled yet / 此时什么也提不走
        escrow.settle(consumer, provider, 800 ether, expires, sig);
        assertEq(bem.balanceOf(provider), 800 ether, "provider that settled inside the cooldown is paid in full");
        assertEq(escrow.claimedOf(consumer, provider), 800 ether);

        // Step 4/5: the matured withdraw pays only what was never settled. / 到期提现只拿回未被结算的部分。
        vm.warp(availableAt);
        uint256 before = bem.balanceOf(consumer);
        vm.prank(consumer);
        escrow.withdraw(provider);
        assertEq(bem.balanceOf(consumer) - before, 200 ether, "the consumer recovers only the unspent 200");
        assertEq(escrow.channelOf(consumer, provider), 0);
    }

    /// @dev E-03, the other half, stated plainly: a provider that serves AFTER the request has matured and does not
    ///      settle before the consumer fires `withdraw()` is not paid. v1 gave the same outcome to a provider that
    ///      ignored `AllowanceDecreaseRequested` for 24h (its voucher clamped to a cap of 0). The on-chain guarantee
    ///      is the window, nothing more; the reference provider therefore refuses to serve against an armed request
    ///      (TAP-22 §3.2(4)), which is the off-chain half of the same defence v1's server already had.
    ///      E-03 的另一半：请求到期后才提供服务、又没赶在 `withdraw()` 前结算的提供者拿不到钱。v1 中忽略
    ///      `AllowanceDecreaseRequested` 24 小时的提供者结局相同。链上保证就是窗口本身；参考实现的提供者因此
    ///      拒绝对已上膛的请求提供服务（TAP-22 §3.2(4)）。
    function test_attack_E03_prearmedWithdraw_providerThatIgnoresTheWindowIsNotPaid() public {
        uint64 t0 = uint64(block.timestamp);
        vm.prank(consumer);
        escrow.requestWithdraw(provider, CHANNEL);
        uint64 availableAt = t0 + escrow.WITHDRAW_COOLDOWN();

        // Steps 2-3: the attacker waits out the cooldown, THEN consumes 800 off-chain and signs.
        // 第二、三步：等过冷静期，然后链下消费 800 并签发凭证。
        vm.warp(availableAt + 1);
        uint64 expires = uint64(block.timestamp + 1 hours);
        bytes memory sig = _voucher(CONSUMER_PK, provider, 800 ether, expires);
        // What the provider could have read before serving: an executable request for the whole channel.
        // 提供者服务前本可读到的事实：整条通道上有一笔已可执行的提现请求。
        (uint256 armed,) = escrow.pendingWithdraw(consumer, provider);
        assertEq(armed, CHANNEL);
        assertTrue(block.timestamp >= availableAt && block.timestamp <= availableAt + escrow.WITHDRAW_WINDOW());

        // Step 4: withdraw front-runs the settle in the same block. It succeeds -- this is the trade.
        // 第四步：提现在同一区块抢跑结算。它成功了——这就是取舍。
        vm.prank(consumer);
        escrow.withdraw(provider);
        assertEq(escrow.channelOf(consumer, provider), 0);
        vm.expectRevert(InsufficientBalance.selector);
        escrow.settle(consumer, provider, 800 ether, expires, sig);
        assertEq(bem.balanceOf(provider), 0, "a provider that served past the window and settled late is not paid");

        // The voucher is not void, only unfunded: it pays in full the moment the channel is funded again.
        // 凭证并未作废，只是没钱可付：通道再充值时立即足额兑付。
        vm.prank(consumer);
        escrow.fund(provider, 800 ether);
        escrow.settle(consumer, provider, 800 ether, expires, sig);
        assertEq(bem.balanceOf(provider), 800 ether);
    }

    /// @dev E-03b, the honest half: an over-funded channel can be partly withdrawn while a provider keeps getting
    ///      paid in full, as long as it settles inside the cooldown. / 超额充值的通道可以部分提走，冷静期内结算的
    ///      provider 仍足额收款。
    function test_attack_E03b_partialWithdrawStillPaysProviderInFull() public {
        vm.prank(consumer);
        escrow.fund(provider, 1_500 ether);   // channel 2500
        vm.prank(consumer);
        escrow.requestWithdraw(provider, 1_500 ether);

        vm.warp(block.timestamp + 12 hours);
        uint64 expires = uint64(block.timestamp + 1 hours);
        escrow.settle(consumer, provider, 800 ether, expires, _voucher(CONSUMER_PK, provider, 800 ether, expires));
        assertEq(bem.balanceOf(provider), 800 ether, "provider must be paid in full, not a remainder");

        vm.warp(block.timestamp + escrow.WITHDRAW_COOLDOWN());
        vm.prank(consumer);
        escrow.withdraw(provider);
        assertEq(escrow.channelOf(consumer, provider), 200 ether, "1500 left, 800 settled, 200 remain");
    }

    /// @dev E-03c, the execution window: a request cannot stay armed forever. Before the cooldown it reverts
    ///      CooldownActive; after cooldown + 7d it is stale and must be re-made (restarting the 48h).
    ///      执行窗口：请求不能无限期上膛。冷却期内回滚 CooldownActive，冷却 + 7d 后失效需重新请求。
    function test_attack_E03c_staleWithdrawWindowClosed() public {
        uint64 requestedAt = uint64(block.timestamp);
        vm.prank(consumer);
        escrow.requestWithdraw(provider, CHANNEL);
        uint64 availableAt = requestedAt + escrow.WITHDRAW_COOLDOWN();

        vm.warp(availableAt - 1);
        vm.prank(consumer);
        vm.expectRevert(abi.encodeWithSelector(CooldownActive.selector, availableAt));
        escrow.withdraw(provider);

        vm.warp(uint256(availableAt) + escrow.WITHDRAW_WINDOW() + 1);
        vm.prank(consumer);
        vm.expectRevert(WithdrawWindowClosed.selector);
        escrow.withdraw(provider);
        assertEq(escrow.channelOf(consumer, provider), CHANNEL, "funds stay in the channel until a fresh request matures");

        // A pre-armed request from weeks ago cannot be fired in a settle block. / 数周前上膛的请求无法在结算区块引爆。
        vm.prank(consumer);
        escrow.requestWithdraw(provider, CHANNEL);
        vm.warp(block.timestamp + escrow.WITHDRAW_COOLDOWN() + 1);
        vm.prank(consumer);
        escrow.withdraw(provider);
        assertEq(escrow.channelOf(consumer, provider), 0);
    }

    /// @dev E-03d, the rolling variant ("之后照常消费数日"): fund -> requestWithdraw -> consume -> drain -> repeat.
    ///      Each turn of the cycle pays the provider for everything it settled inside the cooldown; the attacker
    ///      recovers only what was never settled, and must fund again to consume again.
    ///      滚动重复的"上膛 -> 消费 -> 清空"循环：冷静期内结算的每一单都被付款；攻击者只拿回未结算部分。
    function test_attack_E03d_rollingRearmCycleYieldsNoFreeServiceToAWatchingProvider() public {
        uint256 pk = 0xA77AC4;
        address atk = _newConsumer(pk, 1_000 ether);

        // ---- cycle 1 ----
        vm.prank(atk);
        escrow.requestWithdraw(provider, 1_000 ether);
        uint64 expires = uint64(block.timestamp + 12 hours);
        bytes memory sig = _voucherAs(pk, atk, provider, 800 ether, expires);
        vm.warp(block.timestamp + 6 hours);
        escrow.settle(atk, provider, 800 ether, expires, sig);
        assertEq(bem.balanceOf(provider), 800 ether, "the 800 consumed in the window is paid");
        vm.warp(block.timestamp + escrow.WITHDRAW_COOLDOWN());
        vm.prank(atk);
        escrow.withdraw(provider);
        assertEq(escrow.channelOf(atk, provider), 0, "only the unspent 200 came back");

        // ---- cycle 2: to consume again the attacker must fund again ----
        // 第二轮：想再消费就必须再充值。
        uint64 exp2 = uint64(block.timestamp + 1 hours);
        bytes memory sig2 = _voucherAs(pk, atk, provider, 1_300 ether, exp2);
        vm.expectRevert(InsufficientBalance.selector);
        escrow.settle(atk, provider, 1_300 ether, exp2, sig2);   // an empty channel buys nothing / 空通道买不到服务
        vm.prank(atk);
        escrow.fund(provider, 500 ether);
        vm.prank(atk);
        escrow.requestWithdraw(provider, 500 ether);
        escrow.settle(atk, provider, 1_300 ether, exp2, sig2);   // settled inside the new cooldown / 在新的冷静期内结算
        assertEq(bem.balanceOf(provider), 1_300 ether, "every unit served across both cycles was paid for");
        assertEq(escrow.channelOf(atk, provider), 0);
        vm.warp(block.timestamp + escrow.WITHDRAW_COOLDOWN());
        vm.prank(atk);
        vm.expectRevert(InsufficientBalance.selector);
        escrow.withdraw(provider);                                // nothing left to drain / 已无可清空
    }

    // ------------------------------------------------------------------------------------
    // E-04 (Medium) — "余额 1000，对 A、B 各 allowance 1000；分别签 800 给 A 和 800 给 B（两边链下校验
    //   都通过）。A 先结算，余额剩 200；B 的 `settle(800)` 回滚 `InsufficientBalance`，连 200 也拿不到，
    //   只能等消费者再充值（消费者可以直接提走这 200）。PoC-5 已复现。"
    //
    // v2: INEXPRESSIBLE. There is no shared balance for two providers to race over. A voucher toward B can only
    // ever be paid from the (consumer, B) channel; A settling changes nothing B can see. The closest thing left
    // is the honest one: each provider is paid up to its own channel, in either order.
    // v2：无法表达。没有可供两个提供者竞争的共享余额；对 B 的凭证只能从 (consumer, B) 通道支付。
    // ------------------------------------------------------------------------------------
    function test_attack_E04_sharedBalanceRace_isInexpressible() public {
        // Channels are separate: 1000 toward A (setUp), 400 toward B. / 通道各自独立。
        vm.prank(consumer);
        escrow.fund(provider2, 400 ether);
        uint64 expires = uint64(block.timestamp + 1 hours);
        bytes memory toA = _voucher(CONSUMER_PK, provider, 800 ether, expires);
        bytes memory toB = _voucher(CONSUMER_PK, provider2, 800 ether, expires);

        // A settles first and takes 800 from ITS channel. B's channel is untouched.
        // A 先结算，从自己的通道拿 800；B 的通道分毫未动。
        escrow.settle(consumer, provider, 800 ether, expires, toA);
        assertEq(bem.balanceOf(provider), 800 ether);
        assertEq(escrow.channelOf(consumer, provider2), 400 ether, "A's settlement cannot touch B's channel");

        // B is paid up to its own channel (a partial settlement: B extended 400 of credit), and the remainder
        // becomes payable when the consumer funds B again -- the consumer cannot take B's 400 out from under it
        // faster than 48h. B 按自己的通道收款（部分结算：B 赊了 400），补充通道后可续结。
        escrow.settle(consumer, provider2, 800 ether, expires, toB);
        assertEq(bem.balanceOf(provider2), 400 ether, "B collects its own channel regardless of A");
        assertEq(escrow.claimedOf(consumer, provider2), 400 ether);
        vm.prank(consumer);
        escrow.fund(provider2, 400 ether);
        escrow.settle(consumer, provider2, 800 ether, expires, toB);
        assertEq(bem.balanceOf(provider2), 800 ether, "same signature settles the remainder");
    }

    // ------------------------------------------------------------------------------------
    // R-01 (audit §3.1(6) / §2 "跨合约重放") — a voucher signed for escrow A must not be settleable
    //   on escrow B: the EIP-712 domain binds `verifyingContract`.
    //   为托管合约 A 签发的凭证不能在托管合约 B 上结算（EIP-712 域绑定 verifyingContract）。
    //
    // v2: STILL DEFENDED (domain unchanged from v1). / v2：防御原样保留（域与 v1 相同）。
    // ------------------------------------------------------------------------------------
    function test_attack_R01_voucherReplayAcrossEscrows() public {
        // A second, fully funded escrow so a rejection can only be about the signature domain.
        // 第二个托管合约同样充值，确保拒绝只可能源于签名域不同。
        TapeAPIEscrow escrowB = new TapeAPIEscrow(address(bem), address(hub), treasury);
        vm.startPrank(consumer);
        bem.approve(address(escrowB), type(uint256).max);
        escrowB.fund(provider, CHANNEL);
        vm.stopPrank();
        vm.prank(vm.addr(0x0F0F)); escrowB.setContribution(address(nft), TOKEN1, 0);   // as in setUp / 同 setUp
        assertTrue(escrow.DOMAIN_SEPARATOR() != escrowB.DOMAIN_SEPARATOR());

        uint64 expires = uint64(block.timestamp + 1 hours);
        bytes memory sigA = _voucher(CONSUMER_PK, provider, 100 ether, expires); // signed for escrow A

        // Control: it is a perfectly good voucher on escrow A / 对照：在 A 上完全有效
        escrow.settle(consumer, provider, 100 ether, expires, sigA);
        assertEq(bem.balanceOf(provider), 100 ether);

        // Attack: replay the same signature on escrow B / 攻击：在 B 上重放同一签名
        vm.expectRevert(BadSignature.selector);
        escrowB.settle(consumer, provider, 100 ether, expires, sigA);
        assertEq(escrowB.claimedOf(consumer, provider), 0, "cross-escrow replay must not pay out");
        assertEq(escrowB.channelOf(consumer, provider), CHANNEL, "escrow B channel untouched");

        // Non-adversarial twin: a voucher properly signed for escrow B does settle there.
        // 正常路径：为 B 正确签发的凭证可在 B 上结算。
        bytes memory sigB = _sign(CONSUMER_PK, escrowB.voucherDigest(consumer, provider, 100 ether, expires));
        escrowB.settle(consumer, provider, 100 ether, expires, sigB);
        assertEq(bem.balanceOf(provider), 200 ether);
    }

    // ------------------------------------------------------------------------------------
    // C-01 (Critical, 审计复现) — "托管有两个出口通向同一笔钱。`withdraw()` 在执行时复查可提额，
    //   `settle()` 不查，而 `provider` 是任意地址。消费者用完 1000 服务后，在同一个区块里：
    //   `setAllowance(自己, 1000)`（上调立即生效）→ 签一张把自己写成 provider 的凭证 → `settle`。
    //   余额清零，诚实 provider 手上有效、未过期、在额度之内的凭证回滚 InsufficientBalance。
    //   三道 24 小时延迟全部被绕过，链下也无从防守——第二笔授权是在服务交付之后才创建的。"
    //
    // v2: INEXPRESSIBLE. There is no second allowance to open, and there is no shared pot for two exits to lead
    // to: the honest provider's money sits in channel[consumer][provider], and nothing addressed to any other
    // provider -- including the consumer itself -- can be paid from it. The closest the attacker can do is fund a
    // channel to itself with NEW money and settle that back to itself, which moves only its own money (N-06).
    // v2：无法表达。没有第二笔授权可开，也没有两条出口通向的共享池。攻击者最多用**新钱**给自己开通道再结算
    // 给自己——只搬动了自己的钱。
    // ------------------------------------------------------------------------------------
    function test_attack_C01_selfDealDrain_isInexpressible() public {
        // Service is consumed off chain; the honest provider holds a valid voucher for the whole channel.
        // 链下消费完毕，诚实 provider 手持一张覆盖整条通道的有效凭证。
        uint64 expires = uint64(block.timestamp + 1 hours);
        bytes memory honest = _voucher(CONSUMER_PK, provider, CHANNEL, expires);

        // Attack, same block: a voucher naming the consumer as provider. Without a self-channel it pays nothing.
        // 攻击，同一区块：把自己写成 provider 的凭证。没有自我通道时一分钱也付不出。
        bytes memory selfVoucher = _voucher(CONSUMER_PK, consumer, CHANNEL, expires);
        vm.expectRevert(InsufficientBalance.selector);
        escrow.settle(consumer, consumer, CHANNEL, expires, selfVoucher);
        assertEq(escrow.channelOf(consumer, provider), CHANNEL, "the honest provider's channel is not addressable");

        // Even funding a self-channel with NEW money and settling it moves only that new money.
        // 即便用新钱给自己开通道并结算，搬动的也只是那笔新钱。
        uint256 wallet = bem.balanceOf(consumer);
        vm.prank(consumer);
        escrow.fund(consumer, CHANNEL);
        escrow.settle(consumer, consumer, CHANNEL, expires, selfVoucher);
        // The consumer's own address is no circuit's container, so nobody can set its contribution: the TAPI-22 §3.4
        // default (1%) goes to the treasury and the rest comes back. / 消费者自己的地址不是任何电路的容器，没人能为它
        // 设贡献比例：默认 1% 进金库，其余原路返回。
        uint256 dflt = CHANNEL * escrow.DEFAULT_CONTRIBUTION_BPS() / 10_000;
        assertEq(bem.balanceOf(consumer), wallet - dflt, "self-settlement is a round trip of the consumer's own money, less the default contribution");
        assertEq(bem.balanceOf(treasury), dflt, "the default contribution is the only thing that leaves");
        assertEq(escrow.channelOf(consumer, provider), CHANNEL, "still untouched");

        // The honest provider is paid in full. / 诚实 provider 足额收款。
        escrow.settle(consumer, provider, CHANNEL, expires, honest);
        assertEq(bem.balanceOf(provider), CHANNEL, "honest provider must be paid in full");
        assertEq(bem.balanceOf(address(escrow)), 0, "solvency identity holds: every channel is now empty");
    }

    // ------------------------------------------------------------------------------------
    // M-01 (Medium) — "`settle` 不校验 `provider`；付给 `address(this)` / `address(0)` 永久销毁资金并破坏
    //   偿付性等式。" Round 2 (N-02) added: "M-01 挡住了结算给 address(0) / address(this)，但没挡住授权给它们。
    //   `setAllowance(address(this), X)` 会合法地把 X 锁进 committed，而这笔承诺永远不可能通过结算释放。"
    //
    // v2: STILL DEFENDED, and N-02 is closed as well: `fund` and `authorizeSession` refuse the same two addresses,
    // so no channel toward them can ever exist. / v2：防御保留，且 N-02 一并关闭：这两个地址连通道都开不出来。
    // ------------------------------------------------------------------------------------
    function test_attack_M01_settleFundOrSessionToEscrowOrZeroIsRefused() public {
        uint64 expires = uint64(block.timestamp + 1 hours);
        for (uint256 i = 0; i < 2; i++) {
            address bad = i == 0 ? address(escrow) : address(0);
            bytes memory sig = _voucher(CONSUMER_PK, bad, 1 ether, expires);
            vm.expectRevert(BadProvider.selector);
            escrow.settle(consumer, bad, 1 ether, expires, sig);
            vm.prank(consumer);
            vm.expectRevert(BadProvider.selector);
            escrow.fund(bad, 1 ether);
            vm.prank(consumer);
            vm.expectRevert(BadProvider.selector);
            escrow.authorizeSession(bad, sessionKey, uint64(block.timestamp + 1 days));
            assertEq(escrow.channelOf(consumer, bad), 0);
        }
        assertEq(bem.balanceOf(address(escrow)), CHANNEL, "bem.balanceOf(escrow) == sum of channels");
    }

    // ------------------------------------------------------------------------------------
    // H-01 (High) — "`settle` 要求会话覆盖凭证的整个生命周期 (`sessionExpiry >= expires`)。`revokeSession` 把
    //   到期时间压到 min(current, now + 24h)。于是任何 `expires > now + 24h` 的已签发凭证在撤销的那一刻就失效。"
    //   Sequence: authorizeSession(K, now+30d); K signs Voucher(expires = now+7d); revokeSession(K); same block
    //   settle -> BadSignature.
    //
    // v2: INEXPRESSIBLE (no revoke) and the live-at-settlement rule that closed H-01 is kept. The attacker's
    // step 3 has no equivalent; the voucher settles for as long as the session is live.
    // v2：无法表达（无撤销），且关闭 H-01 的"结算时有效"规则保留。
    // ------------------------------------------------------------------------------------
    function test_attack_H01_revokeInstantlyStrandsLongVoucher_noRevokeExists() public {
        uint64 sessionExp = uint64(block.timestamp + 30 days);   // exactly MAX_SESSION / 恰为最长期限
        vm.prank(consumer);
        escrow.authorizeSession(provider, sessionKey, sessionExp);
        uint64 expires = uint64(block.timestamp + 7 days);
        bytes memory sig = _voucher(SESSION_PK, provider, 500 ether, expires);

        // Step 3 has no spelling in v2; the only "revoke" attempts revert. / 第三步在 v2 无从表达。
        vm.prank(consumer);
        vm.expectRevert(SessionShorteningNotSupported.selector);
        escrow.authorizeSession(provider, sessionKey, uint64(block.timestamp + 1 days));

        // Same block: settles. / 同一区块：结算成功。
        escrow.settle(consumer, provider, 500 ether, expires, sig);
        assertEq(bem.balanceOf(provider), 500 ether, "a long-dated voucher cannot be stranded");

        // The session's natural end is the only cut-off, and it is visible up front.
        // 会话自然到期是唯一的截止点，且事先可见。
        vm.warp(sessionExp);
        escrow.settle(consumer, provider, 600 ether, sessionExp + 1 days, _voucher(SESSION_PK, provider, 600 ether, sessionExp + 1 days));
        vm.warp(sessionExp + 1);
        bytes memory dead = _voucher(SESSION_PK, provider, 700 ether, sessionExp + 1 days);
        vm.expectRevert(BadSignature.selector);
        escrow.settle(consumer, provider, 700 ether, sessionExp + 1 days, dead);
    }

    // ------------------------------------------------------------------------------------
    // revokeSession bypass #1 (REVIEW-CONTRACTS / round 1 §6.4): "`authorizeSession` 的 extend-only 确实堵住了
    //   `authorizeSession(key, 0)` 这条即时撤销后门" -- i.e. without extend-only, re-authorising with 0 or `now`
    //   is an instant revoke that defeats the delay.
    // revokeSession bypass #2 (round 2 test_C5): "extend-only + 新规则能让诚实 provider 在 24h 内被截断吗？
    //   能，但只能靠「一开始就授权一把短命 key」，而这个到期时间是链上可见、provider 服务前就能读到的。"
    //
    // v2: #1 INEXPRESSIBLE (extend-only is kept, and there is no delay left to defeat); #2 SAME GUARANTEE: a
    // 10-minute key truncates exposure to 10 minutes, and the provider can read that before serving.
    // v2：#1 无法表达（保留只可延长，且已无延迟可绕）；#2 同 v1：短命密钥的截断事先在链上可见。
    // ------------------------------------------------------------------------------------
    function test_attack_revokeBypass_authorizeSessionZero_andShortKeyIsVisibleUpFront() public {
        // #1: authorizeSession(key, 0) / (key, now) / (key, shorter) are all refused after a long authorisation.
        uint64 long = uint64(block.timestamp + 10 days);
        vm.startPrank(consumer);
        escrow.authorizeSession(provider, sessionKey, long);
        vm.expectRevert(Expired.selector);
        escrow.authorizeSession(provider, sessionKey, 0);
        vm.expectRevert(Expired.selector);
        escrow.authorizeSession(provider, sessionKey, uint64(block.timestamp));
        vm.expectRevert(SessionShorteningNotSupported.selector);
        escrow.authorizeSession(provider, sessionKey, long - 1);
        vm.stopPrank();
        uint64 expires = uint64(block.timestamp + 1 hours);
        escrow.settle(consumer, provider, 100 ether, expires, _voucher(SESSION_PK, provider, 100 ether, expires));
        assertEq(escrow.claimedOf(consumer, provider), 100 ether);

        // #2: a short-lived key on a fresh channel. The provider reads sessionExpiry BEFORE serving, so the
        // 10-minute bound is announced, not sprung. 短命密钥：provider 服务前读到 sessionExpiry，边界是预告的。
        uint256 pk = 0x5AFE;
        address c2 = _newConsumer(pk, 500 ether);
        address shortKey = vm.addr(0x5E552);
        uint64 shortExp = uint64(block.timestamp + 10 minutes);
        vm.prank(c2);
        escrow.authorizeSession(provider, shortKey, shortExp);
        assertEq(escrow.sessionExpiry(c2, provider, shortKey), shortExp, "visible on-chain before any service");
        bytes memory s1 = _voucherAs(0x5E552, c2, provider, 50 ether, uint64(block.timestamp + 1 hours));
        escrow.settle(c2, provider, 50 ether, uint64(block.timestamp + 1 hours), s1);   // inside the 10 minutes / 十分钟内
        vm.warp(shortExp + 1);
        bytes memory s2 = _voucherAs(0x5E552, c2, provider, 60 ether, uint64(block.timestamp + 1 hours));
        vm.expectRevert(BadSignature.selector);
        escrow.settle(c2, provider, 60 ether, uint64(block.timestamp + 1 hours), s2);      // announced cut-off / 预告的截止
    }

    // ------------------------------------------------------------------------------------
    // N-03 (round 2, Low) — "合约里没有任何东西把凭证绑到「签发时刻」。一把尚未授权的 key 现在就可以签；消费者
    //   一旦授权这把 key，那张旧凭证立刻可结算。一把自然过期的 key 在 200 天后被重新授权，它在旧窗口里签的凭证会
    //   复活并足额支付。实际危害被 `cumulative` 的单调性压得很低。缓解：不要复用 session key。"
    //
    // v2: STILL PRESENT, same bound as v1: a revived voucher pays at most `cumulative - claimed` on that ONE channel,
    // and nothing when a later voucher already covered it. Recorded, not fixed; the mitigation (one key per
    // engagement) is documented in TAP-22 §8. / v2：仍然存在，边界与 v1 相同，且现在限于一条通道。
    // ------------------------------------------------------------------------------------
    function test_attack_N03_reauthorisedKeyRevivesOldVoucher_boundedByClaimedAndChannel() public {
        // A key that is not (yet) authorised signs a voucher: unsettleable now. / 尚未授权的密钥签发的凭证：现在不可结算。
        uint64 far = uint64(block.timestamp + 20 days);
        bytes memory early = _voucher(SESSION_PK, provider, 300 ether, far);
        vm.expectRevert(BadSignature.selector);
        escrow.settle(consumer, provider, 300 ether, far, early);

        // The consumer authorises the key: the old voucher is live at once. / 消费者授权该密钥：旧凭证立刻可结算。
        vm.prank(consumer);
        escrow.authorizeSession(provider, sessionKey, uint64(block.timestamp + 1 days));
        escrow.settle(consumer, provider, 300 ether, far, early);
        assertEq(escrow.claimedOf(consumer, provider), 300 ether);

        // Bound: once claimed has moved past it, a revived voucher pays nothing; and it can never reach another
        // channel. 边界：claimed 越过后复活的凭证一无所获，且永远碰不到另一条通道。
        escrow.settle(consumer, provider, 400 ether, far, _voucher(CONSUMER_PK, provider, 400 ether, far));
        vm.expectRevert(NothingToSettle.selector);
        escrow.settle(consumer, provider, 300 ether, far, early);
        vm.prank(consumer);
        escrow.fund(provider2, 100 ether);
        bytes memory other = _voucher(SESSION_PK, provider2, 100 ether, far);
        vm.expectRevert(BadSignature.selector);
        escrow.settle(consumer, provider2, 100 ether, far, other);
    }

    // ------------------------------------------------------------------------------------
    // L-04 (round 1, Low; round 2 test_B8) — "`withdraw()` 无条件 delete _pending 然后按 free 截断。若期间发生结算
    //   导致 free < p.amount，消费者只拿到截断后的部分，请求整个消失，剩余部分要重新 requestWithdraw 再等 24h。"
    //
    // v2: STILL PRESENT by design (now 48h), direction favours the provider. Asserted so the behaviour is pinned.
    // v2：设计如此（现为 48h），方向偏向提供者。固定下来以免回归。
    // ------------------------------------------------------------------------------------
    function test_attack_L04_clampedWithdrawClearsTheRequest() public {
        vm.prank(consumer);
        escrow.requestWithdraw(provider, CHANNEL);
        uint64 expires = uint64(block.timestamp + 3 days);
        escrow.settle(consumer, provider, 600 ether, expires, _voucher(CONSUMER_PK, provider, 600 ether, expires));
        vm.warp(block.timestamp + escrow.WITHDRAW_COOLDOWN());
        uint256 before = bem.balanceOf(consumer);
        vm.prank(consumer);
        escrow.withdraw(provider);
        assertEq(bem.balanceOf(consumer) - before, 400 ether, "clamped to what the settlement left");
        (uint256 amt,) = escrow.pendingWithdraw(consumer, provider);
        assertEq(amt, 0, "the request is consumed even though it was clamped");
        vm.prank(consumer);
        vm.expectRevert(NoPendingWithdraw.selector);
        escrow.withdraw(provider);
    }

    // ------------------------------------------------------------------------------------
    // Round 3 E-02 (Low) — "`settle` MUST 列表要求 `cumulative ≤ allowanceOf` 否则失败；代码截断而不是拒绝。
    //   Round 2 N-07: 部分结算现在不可达（死代码）。"
    //
    // v2: there is no allowance clamp at all; the channel is the only cap, and paying up to it is the documented
    // credit flow (a REACHABLE partial settlement). / v2：没有额度截断；通道即唯一上限，部分结算是可达的合法流程。
    // ------------------------------------------------------------------------------------
    function test_attack_E02r3_voucherAboveChannelPaysTheChannel_partialIsReachable() public {
        uint64 expires = uint64(block.timestamp + 1 hours);
        bytes memory over = _voucher(CONSUMER_PK, provider, CHANNEL + 500 ether, expires);
        escrow.settle(consumer, provider, CHANNEL + 500 ether, expires, over);
        assertEq(bem.balanceOf(provider), CHANNEL, "paid up to the channel, not rejected");
        assertEq(escrow.claimedOf(consumer, provider), CHANNEL, "claimed advances by what was paid");
        vm.expectRevert(InsufficientBalance.selector);
        escrow.settle(consumer, provider, CHANNEL + 500 ether, expires, over);
        vm.prank(consumer);
        escrow.fund(provider, 500 ether);
        escrow.settle(consumer, provider, CHANNEL + 500 ether, expires, over);
        assertEq(bem.balanceOf(provider), CHANNEL + 500 ether, "the same signature settles the remainder");
    }

    // ------------------------------------------------------------------------------------
    // I-02 (round 1, Info) — "贡献向下取整；`pay` 极小时金库拿 0。provider 永远拿不到 0（bps ≤ 50%）。"
    // E-09 (REVIEW-CONTRACTS) — "`expires == now` 有效：合约用 `<`，与 server 有 1 秒判定差异。"
    //
    // v2: both unchanged; pinned. The cap is 20% since 2026-10-05, so the bound only got tighter.
    // v2：两者不变；固定下来。上限自 2026-10-05 起为 20%，这个界只会更紧。
    // ------------------------------------------------------------------------------------
    function test_attack_I02_E09_roundingNeverStarvesProvider_andExpiryIsInclusive() public {
        vm.prank(vm.addr(0xA11CE));
        nft.mint(vm.addr(0xA11CE), TOKEN1);
        uint16 cap = escrow.MAX_CONTRIBUTION_BPS();   // 2000 since 2026-10-05 (was 5000) / 自 2026-10-05 起为 2000
        vm.prank(vm.addr(0xA11CE));
        escrow.setContribution(address(nft), TOKEN1, cap);
        uint64 expires = uint64(block.timestamp + 10);
        bytes memory one = _voucher(CONSUMER_PK, provider, 1, expires);
        vm.warp(expires);                                              // E-09: the last valid second / 最后一秒仍有效
        escrow.settle(consumer, provider, 1, expires, one);
        assertEq(bem.balanceOf(provider), 1, "provider always receives > 0 when pay > 0");
        assertEq(bem.balanceOf(treasury), 0, "dust rounds the treasury share to 0");
        bytes memory late = _voucher(CONSUMER_PK, provider, 2, expires);
        vm.warp(expires + 1);
        vm.expectRevert(Expired.selector);
        escrow.settle(consumer, provider, 2, expires, late);
    }

    // ------------------------------------------------------------------------------------
    // Decision claim (docs/DECISION-escrow-v2.md): "会话密钥泄露：限于一个通道，无需撤销，自然过期。"
    // A leaked key for the (consumer, provider) channel cannot spend any other channel of the same consumer,
    // and cannot be authorised for longer than MAX_SESSION. / 泄露的密钥只能花一条通道，且不超过 30 天。
    // ------------------------------------------------------------------------------------
    function test_attack_leakedSessionKeyIsBoundedByOneChannelAndMaxSession() public {
        vm.startPrank(consumer);
        escrow.fund(provider2, 5_000 ether);   // the consumer's larger channel elsewhere / 消费者在别处更大的通道
        escrow.authorizeSession(provider, sessionKey, uint64(block.timestamp + 30 days));
        vm.expectRevert(abi.encodeWithSelector(SessionTooLong.selector, uint64(block.timestamp) + 30 days));
        escrow.authorizeSession(provider, sessionKey, uint64(block.timestamp + 30 days + 1));
        vm.stopPrank();

        // The thief signs for every provider it can think of; only the one channel pays, and only up to its balance.
        // 窃贼对能想到的每个提供者都签一张；只有那一条通道付款，且不超过其余额。
        uint64 expires = uint64(block.timestamp + 1 hours);
        bytes memory drain = _voucher(SESSION_PK, provider, type(uint128).max, expires);
        escrow.settle(consumer, provider, type(uint128).max, expires, drain);
        assertEq(bem.balanceOf(provider), CHANNEL, "loss capped at that channel's balance");
        bytes memory elsewhere = _voucher(SESSION_PK, provider2, 1 ether, expires);
        vm.expectRevert(BadSignature.selector);
        escrow.settle(consumer, provider2, 1 ether, expires, elsewhere);
        assertEq(escrow.channelOf(consumer, provider2), 5_000 ether, "the larger channel is out of reach");
    }
}

// ============================================================================================
//                                 SERVICE DIRECTORY ATTACKS
// ============================================================================================

contract DirectoryAttacksTest is Test {
    Atk_MockERC721 nft;
    Atk_MockHub hub;
    Atk_MockFactory factory;
    ServiceDirectory dir;

    uint256 constant HOLDER_PK = 0xA11CE;
    address holder;
    address attacker = address(0xBADBAD);
    address stranger = address(0x57A2);

    uint256 constant TOKEN = 4246;
    bytes32 constant LABEL = bytes32("reader");
    string constant PATH = "/.well-known/tapeapi.json";
    address constant SIGNER = address(0x5167);

    address container;

    function setUp() public {
        vm.warp(1_758_300_000);
        holder = vm.addr(HOLDER_PK);
        nft = new Atk_MockERC721();
        hub = new Atk_MockHub();
        factory = new Atk_MockFactory();
        factory.set(address(nft), true);
        dir = new ServiceDirectory(address(hub), address(factory), address(0)); // no gate / 不启用门槛
        nft.mint(holder, TOKEN);
        container = hub.accountOf(address(nft), TOKEN);
        vm.deal(holder, 10 ether);
        vm.deal(attacker, 10 ether);
    }

    // ------------------------------------------------------------------------------------
    // D-01 (Medium) — "攻击者部署一个 `ownerOf` 恒返回自己的假 ERC-721，即可通过持有人检查；
    //   `hub.accountOf` 对任意 NFT 合约都能推导出确定地址。默认部署（`labelFee = 0`，`domainBinding = 0`）
    //   下抢注标签、刷 `count()/at()` 枚举和 `Registered` 事件只花 gas。一笔交易注册 50 个标签（PoC-9,
    //   约 12.3M gas）。所有短小可读标签在上线首日即可被同一人扫光。"
    //
    // Now blocked: `register` requires `factory.isCPU(circuits)`.
    // ------------------------------------------------------------------------------------
    function test_attack_D01_fakeERC721MassLabelSquatting() public {
        Atk_FakeCircuits fake = new Atk_FakeCircuits(attacker);

        // Attack: sweep 50 short, desirable labels with a home-made ERC-721.
        // 攻击：用自制 ERC-721 扫光 50 个短标签。
        for (uint256 i = 0; i < 50; i++) {
            bytes32 label = bytes32(uint256(keccak256(abi.encode("squat", i))));
            vm.prank(attacker);
            vm.expectRevert(NotCPU.selector);
            dir.register(address(fake), i, label, PATH);
            assertEq(dir.resolve(label), address(0));
        }
        assertEq(dir.count(), 0, "no squatted registration may exist");

        // The gate is about provenance, not about the NFT being well-behaved: the attacker's
        // ownerOf would have passed the holder check happily.
        // 门槛看的是来源而非 NFT 行为本身：攻击者的 ownerOf 本来完全能通过持有人检查。
        assertEq(fake.ownerOf(0), attacker);

        // Non-adversarial twin: a genuine factory circuit registers fine.
        // 正常路径：真实工厂电路可正常登记。
        vm.prank(holder);
        dir.register(address(nft), TOKEN, LABEL, PATH);
        assertEq(dir.resolve(LABEL), container);
        assertEq(dir.count(), 1);
    }

    // ------------------------------------------------------------------------------------
    // D-02 (Medium) — "攻击者用真电路或假 NFT 注册热门标签后销毁 token：标签永久占位。PoC-10 已复现。
    //   非恶意：持有人误销毁电路，其标签同样永久丢失。"（`ownerOf` 对已销毁 token 直接 revert →
    //   标签永远无法 `release`，也无人能 `register` 它，`resolve` 继续返回一个死容器。）
    //
    // Now blocked: `_holderOf` catches the revert and returns address(0) — a burned token has no
    // holder, so ANYONE may release the label, while register/update fail closed with NotHolder.
    // ------------------------------------------------------------------------------------
    function test_attack_D02_burnTokenToLockLabelForever() public {
        Atk_MockERC721Strict strict = new Atk_MockERC721Strict(); // OZ-style: ownerOf reverts when burned
        factory.set(address(strict), true);
        uint256 id = 7;
        strict.mint(attacker, id);
        address c = hub.accountOf(address(strict), id);

        vm.prank(attacker);
        dir.register(address(strict), id, LABEL, PATH);
        assertEq(dir.resolve(LABEL), c);

        // Attack: burn the circuit so `ownerOf` reverts and the label is stranded forever.
        // 攻击：销毁电路，使 `ownerOf` 回滚，标签永久占位。
        strict.burn(id);
        vm.expectRevert("ERC721: invalid token ID");
        strict.ownerOf(id);

        // register / update now fail closed (no holder can ever match) / 登记与更新失败关闭
        vm.prank(attacker);
        vm.expectRevert(NotHolder.selector);
        dir.register(address(strict), id, LABEL, PATH);
        vm.prank(attacker);
        vm.expectRevert(NotHolder.selector);
        dir.update(address(strict), id, PATH);

        // Attack fails: anyone may reclaim the stranded label, and `release` does not bubble the revert.
        // 攻击失败：任何人都能释放被占的标签，且 `release` 不会向上抛出 ownerOf 的回滚。
        vm.prank(stranger);
        dir.release(LABEL);
        assertEq(dir.resolve(LABEL), address(0), "burned-token label must be releasable");
        Service memory svc = dir.serviceOf(c);
        assertEq(svc.label, bytes32(0));

        // And the freed label is usable again by a live circuit / 释放后的标签可被有效电路重新占用
        vm.prank(holder);
        dir.register(address(nft), TOKEN, LABEL, PATH);
        assertEq(dir.resolve(LABEL), container);
    }

    // ------------------------------------------------------------------------------------
    // D-03 (Low) — "一个返回非规范 bool 的 DomainBinding 实现会让所有带标签的 `register` 回滚
    //   （不是 `NotLive` 而是 panic）。PoC-8 已复现。"（`abi.decode(ret, (bool))` 对 32 字节 0x…02 直接
    //   revert，与注释 "malformed → false, never a revert of this contract" 矛盾。）
    //
    // Now blocked: `isLive` checks ok && ret.length >= 32 && first word == 1; everything else is
    // "not live" and surfaces as a clean NotLive, never a panic.
    // ------------------------------------------------------------------------------------
    function test_attack_D03_malformedDomainBindingReturn() public {
        Atk_DomainBindingRaw raw = new Atk_DomainBindingRaw();
        ServiceDirectory gated = new ServiceDirectory(address(hub), address(factory), address(raw));

        // Case 1: non-canonical 32-byte bool 0x…02 / 非规范 bool
        raw.setRet(abi.encode(uint256(2)));
        assertFalse(gated.isLive(container), "0x02 must read as not live, not revert");
        vm.prank(holder);
        vm.expectRevert(NotLive.selector);
        gated.register(address(nft), TOKEN, LABEL, PATH);

        // Case 2: short return data (16 bytes) / 返回数据过短
        raw.setRet(hex"00000000000000000000000000000001");
        assertFalse(gated.isLive(container), "short return must read as not live");
        vm.prank(holder);
        vm.expectRevert(NotLive.selector);
        gated.register(address(nft), TOKEN, LABEL, PATH);

        // Case 3: outright revert / 直接回滚
        Atk_DomainBindingRevert boom = new Atk_DomainBindingRevert();
        ServiceDirectory gatedBoom = new ServiceDirectory(address(hub), address(factory), address(boom));
        assertFalse(gatedBoom.isLive(container), "a reverting gate must read as not live");
        vm.prank(holder);
        vm.expectRevert(NotLive.selector);
        gatedBoom.register(address(nft), TOKEN, LABEL, PATH);

        // No label -> gate is not consulted at all, so the malformed gate never bricks the directory.
        // 无标签时不查门槛，畸形门槛不会拖垮整个目录。
        vm.prank(holder);
        gated.register(address(nft), TOKEN, bytes32(0), PATH);
        assertEq(gated.count(), 1);

        // Non-adversarial twin: a canonical `true` lets the label through.
        // 正常路径：规范的 true 可正常占用标签。
        raw.setRet(abi.encode(uint256(1)));
        assertTrue(gated.isLive(container));
        vm.prank(holder);
        gated.register(address(nft), TOKEN, LABEL, PATH);
        assertEq(gated.resolve(LABEL), container);
    }

    // ------------------------------------------------------------------------------------
    // R-02 (audit §2 "跨合约重放") — a Delegation signed for directory A must not verify on
    //   directory B: the EIP-712 domain binds `verifyingContract`.
    //   为目录 A 签发的委托不能在目录 B 上通过校验（EIP-712 域绑定 verifyingContract）。
    // ------------------------------------------------------------------------------------
    /// @dev The delegation domain is anchored on the DeWebHub, so every directory on a chain shares it.
    ///      That is deliberate: a delegation says "the holder of this container authorises this signer" and
    ///      never mentions a directory, so two directories resolving the same container must agree. It is
    ///      safe because a forged delegation still fails the on-chain ownerOf check, and it is what lets a
    ///      service work before any directory is deployed. Cross-CHAIN replay is still prevented.
    ///      委托的域锚定在 DeWebHub，因此同一条链上所有目录共用该域。这是有意为之：委托只表示
    ///      "该容器的持有人授权了这个签名者"，从不提及目录，因此解析同一容器的两个目录必须给出一致结论。
    ///      安全性由链上 ownerOf 校验保证；这也正是"未部署任何目录时服务即可使用"的前提。跨链重放仍被阻止。
    function test_attack_R02_delegationDomainIsSharedPerChain_notPerDirectory() public {
        ServiceDirectory dirB = new ServiceDirectory(address(hub), address(factory), address(0));
        assertEq(dir.DOMAIN_SEPARATOR(), dirB.DOMAIN_SEPARATOR(), "same chain, same hub, same delegation domain");

        uint64 expires = uint64(block.timestamp + 1 hours);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(HOLDER_PK, dir.delegationDigest(container, SIGNER, expires));
        bytes memory sigA = abi.encodePacked(r, s, v);

        assertTrue(dir.verifyDelegation(address(nft), TOKEN, SIGNER, expires, sigA), "verifies on directory A");
        assertTrue(dirB.verifyDelegation(address(nft), TOKEN, SIGNER, expires, sigA), "and on any other directory");

        // The signature must still come from the holder: a stranger's delegation fails on both.
        // 签名仍须来自持有人：他人签发的委托在两边都失败。
        (uint8 v2, bytes32 r2, bytes32 s2) = vm.sign(uint256(0xBADBEEF), dir.delegationDigest(container, SIGNER, expires));
        bytes memory forged = abi.encodePacked(r2, s2, v2);
        assertFalse(dir.verifyDelegation(address(nft), TOKEN, SIGNER, expires, forged), "forged must fail on A");
        assertFalse(dirB.verifyDelegation(address(nft), TOKEN, SIGNER, expires, forged), "forged must fail on B");
    }

    function _signAs(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 ss) = vm.sign(pk, digest);
        return abi.encodePacked(r, ss, v);
    }

    /// @dev SD-01: a hostile or upgraded gate must not be able to brick label registration by returning
    ///      an enormous amount of data. The directory copies at most one word back.
    ///      SD-01：恶意或被升级的门槛合约不得通过返回海量数据瘫痪标签登记；目录最多只回拷一个字。
    function test_attack_SD01_returndataBombCannotBrickRegistration() public {
        Atk_DomainBindingBomb bomb = new Atk_DomainBindingBomb();
        ServiceDirectory d = new ServiceDirectory(address(hub), address(factory), address(bomb));

        for (uint256 n = 1; n <= 200_000; n = n * 20) {
            bomb.setWords(n);
            // The view answers without reverting, whatever the gate returns. / 无论门槛返回什么，视图都不回滚。
            assertTrue(d.isLive(container), "isLive must survive a returndata bomb");
        }

        // And a registration still goes through under the flood. / 洪水之下登记仍然成功。
        bomb.setWords(200_000);
        vm.prank(holder);
        d.register(address(nft), TOKEN, bytes32("bombed"), "/m.json");
        assertEq(d.resolve(bytes32("bombed")), container);
    }

    /// @dev SD-02: TAP-20 3.4 requires `expires` strictly in the future, and says verifyDelegation
    ///      implements exactly that check. A delegation expiring this very second is not valid.
    ///      SD-02：TAP-20 3.4 要求 `expires` 严格位于未来，并规定 verifyDelegation 精确实现该判据。
    function test_SD02_delegationExpiringThisSecondIsInvalid() public {
        uint64 nowTs = uint64(block.timestamp);
        bytes memory sigNow = _signAs(HOLDER_PK, dir.delegationDigest(container, SIGNER, nowTs));
        assertFalse(dir.verifyDelegation(address(nft), TOKEN, SIGNER, nowTs, sigNow), "expires == now is not in the future");

        bytes memory sigNext = _signAs(HOLDER_PK, dir.delegationDigest(container, SIGNER, nowTs + 1));
        assertTrue(dir.verifyDelegation(address(nft), TOKEN, SIGNER, nowTs + 1, sigNext));
    }

}
