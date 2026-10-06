// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// v3: one escrow instance per token, any decimals (TAPI-22 §3.5; the first planned instance is the 18-decimal
// USDT-peg, BEM has 8). The contract never reads `decimals()`; every amount is in the token's base units. These tests
// run the same lifecycle with fixture tokens of 6, 8 and 18 decimals (6 is below the §3.5 admission floor of 8 and
// is here on purpose: admission is a deployment rule, the arithmetic must not care), assert that `decimals()` is
// never called, and fuzz the scale. They are documentation tests: there is no decimals code in the contract for a
// mutant to remove.
//
// Also here: direct transfers ("donations") to the escrow never break any path, and are never paid out by anything
// (no sweep, by design): solvency is `balance >= Σ channel + treasuryAccrued`, not `==`.
//
// v3：每种代币一个实例，任意小数位。合约从不读取 decimals()，所有金额以该代币的最小单位计。用 6、8、18 位的夹具
// 代币跑同一条生命周期（6 位低于 §3.5 的准入下限，刻意保留：准入是部署规则，算术不应在意），断言 decimals() 从未
// 被调用，并对小数位做模糊测试。这些是文档性测试：合约里没有可供变异删除的小数位代码。
// 另：直接转入托管的代币（捐赠）不会破坏任何路径，也不会被任何路径付出（按设计没有清扫）。

import "forge-std/Test.sol";
import {TapeAPIEscrow} from "../src/TapeAPIEscrow.sol";
import {InsufficientBalance, ZeroAmount} from "../src/interfaces.sol";
import {Mal_DecimalsToken, Mal_ERC721, Mal_Hub} from "./mocks/MaliciousTokens.sol";

contract TokenDecimalsTest is Test {
    Mal_ERC721 nft;
    Mal_Hub hub;
    address treasury = address(0x7EA5);
    address holder = address(0xA11CE);
    uint256 constant CONSUMER_PK = 0xC0FFEE;
    uint256 constant SESSION_PK = 0x5E55;
    address consumer;
    address sessionKey;
    address provider;
    uint256 constant TOKEN_ID = 7;

    function setUp() public {
        vm.warp(1_758_300_000);
        consumer = vm.addr(CONSUMER_PK);
        sessionKey = vm.addr(SESSION_PK);
        nft = new Mal_ERC721();
        hub = new Mal_Hub();
        nft.mint(holder, TOKEN_ID);
        provider = hub.accountOf(address(nft), TOKEN_ID);
    }

    function _sig(TapeAPIEscrow e, uint256 pk, uint256 cum, uint64 exp) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, e.voucherDigest(consumer, provider, cum, exp));
        return abi.encodePacked(r, s, v);
    }

    function _deploy(uint8 d) internal returns (Mal_DecimalsToken tok, TapeAPIEscrow esc) {
        tok = new Mal_DecimalsToken(d);
        esc = new TapeAPIEscrow(address(tok), address(hub), treasury);
    }

    /// Fund 100 tokens, pay 12.345678 + 30 tokens through a session key at the default 1%, claim, withdraw the rest.
    /// Every figure is computed the way a client would: whole tokens times 10**decimals.
    /// 充 100 枚，经会话密钥按默认 1% 付 12.345678 + 30 枚，领取，提走余额；每个数字都按客户端方式算：枚数乘 10**小数位。
    function _lifecycle(uint8 d) internal {
        (Mal_DecimalsToken tok, TapeAPIEscrow esc) = _deploy(d);
        uint256 unit = 10 ** uint256(d);
        uint256 funded = 100 * unit;
        // 12.345678 tokens, truncated to what `d` decimals can express (6 decimals: exact) / 按 d 位能表达的精度截断
        uint256 p1 = 12 * unit + (d >= 6 ? 345_678 * 10 ** uint256(d - 6) : 345_678 / 10 ** uint256(6 - d));
        uint256 p2 = p1 + 30 * unit;

        vm.expectCall(address(tok), abi.encodeWithSignature("decimals()"), 0);   // never read / 从不读取

        tok.mint(consumer, funded);
        vm.startPrank(consumer);
        tok.approve(address(esc), type(uint256).max);
        esc.fund(provider, funded);
        esc.authorizeSession(provider, sessionKey, uint64(block.timestamp + 1 days));
        vm.stopPrank();

        uint64 exp = uint64(block.timestamp + 1 hours);
        esc.settle(consumer, provider, p1, exp, _sig(esc, SESSION_PK, p1, exp));
        esc.settle(consumer, provider, p2, exp, _sig(esc, SESSION_PK, p2, exp));
        uint256 c = p1 / 100 + (p2 - p1) / 100;                    // floor per settlement, default 100 bps
        assertEq(tok.balanceOf(provider), p2 - c, "provider: paid minus 1%, in base units");
        assertEq(esc.treasuryAccrued(), c, "accrual: floor(pay * 100 / 1e4) per settlement");
        assertEq(esc.claimedOf(consumer, provider), p2);
        assertEq(esc.channelOf(consumer, provider), funded - p2);
        assertEq(tok.balanceOf(address(esc)), funded - p2 + c, "solvency: channel + accrual");

        esc.claimTreasury();
        assertEq(tok.balanceOf(treasury), c);

        vm.prank(consumer); esc.requestWithdraw(provider, funded - p2);
        vm.warp(block.timestamp + 48 hours);
        vm.prank(consumer); esc.withdraw(provider);
        assertEq(tok.balanceOf(consumer), funded - p2);
        assertEq(tok.balanceOf(address(esc)), 0, "every base unit accounted for");
        assertEq(tok.balanceOf(consumer) + tok.balanceOf(provider) + tok.balanceOf(treasury), funded, "conservation");
    }

    function test_decimals6_lifecycle() public { _lifecycle(6); }
    function test_decimals8_lifecycle() public { _lifecycle(8); }    // BEM
    function test_decimals18_lifecycle() public { _lifecycle(18); }  // USDT-peg on BNB Smart Chain

    /// Any scale 0..30 decimals, any amounts up to 10^12 whole tokens, any rate: the split is exact, the provider is
    /// paid > 0, and the escrow balance equals channel + accrual. pay * bps cannot overflow here: at most
    /// 10^42 * 2000 < 2^256. (It would only for pay > 2^256 / 2000, about 5.8e73 base units, which no admitted token's
    /// supply approaches; recorded as info in docs/AUDIT-escrow-v3.md.)
    /// 任意 0..30 位小数、任意至多 10^12 枚的金额、任意比例：拆分精确、提供者到账 > 0、托管余额 == 通道 + 应收额。
    function testFuzz_anyDecimals_splitExact(uint8 dSeed, uint256 fundSeed, uint256 paySeed, uint16 bpsSeed) public {
        uint8 d = uint8(bound(dSeed, 0, 30));
        (Mal_DecimalsToken tok, TapeAPIEscrow esc) = _deploy(d);
        uint256 funded = bound(fundSeed, 1, 1e12 * 10 ** uint256(d));
        uint256 pay = bound(paySeed, 1, funded);
        uint16 bps = uint16(bound(bpsSeed, 0, esc.MAX_CONTRIBUTION_BPS()));
        vm.prank(holder); esc.setContribution(address(nft), TOKEN_ID, bps);
        tok.mint(consumer, funded);
        vm.startPrank(consumer);
        tok.approve(address(esc), funded);
        esc.fund(provider, funded);
        vm.stopPrank();
        uint64 exp = uint64(block.timestamp + 1 hours);
        esc.settle(consumer, provider, pay, exp, _sig(esc, CONSUMER_PK, pay, exp));
        uint256 c = pay * bps / 10_000;
        assertEq(tok.balanceOf(provider), pay - c);
        assertGt(tok.balanceOf(provider), 0);
        assertEq(esc.treasuryAccrued(), c);
        assertEq(tok.balanceOf(address(esc)), esc.channelOf(consumer, provider) + esc.treasuryAccrued());
    }

    // ---------------------------------------------------------------------------------------------
    // Direct transfers ("donations") / 直接转入（捐赠）
    // ---------------------------------------------------------------------------------------------

    /// A donation before any fund and another in the middle: every path (fund, settle, claim, withdraw) still works
    /// with exact amounts, nothing pays the donation out, and it is exactly what is left at the end. The `==` form of
    /// the v2 identity would be false from the first donation on; the `>=` form holds throughout.
    /// 充值前与中途各一笔捐赠：所有路径照常且金额精确，没有任何路径付出捐赠，最后剩下的恰是捐赠。v2 的 `==` 从第一笔
    /// 捐赠起即不成立，`>=` 全程成立。
    function test_directDonation_neverBreaksAnyPath_andIsNeverPaidOut() public {
        (Mal_DecimalsToken tok, TapeAPIEscrow esc) = _deploy(18);
        uint256 unit = 1e18;
        address donor = address(0xD0D0);
        tok.mint(donor, 10 * unit);
        vm.prank(donor); tok.transfer(address(esc), 3 * unit);                // before any channel exists
        assertGt(tok.balanceOf(address(esc)), esc.treasuryAccrued(), "balance > owed: the == identity is already false");

        tok.mint(consumer, 100 * unit);
        vm.startPrank(consumer);
        tok.approve(address(esc), type(uint256).max);
        esc.fund(provider, 100 * unit);
        vm.stopPrank();
        uint64 exp = uint64(block.timestamp + 1 hours);
        esc.settle(consumer, provider, 40 * unit, exp, _sig(esc, CONSUMER_PK, 40 * unit, exp));
        vm.prank(donor); tok.transfer(address(esc), 7 * unit);                // mid-stream
        assertGe(tok.balanceOf(address(esc)), esc.channelOf(consumer, provider) + esc.treasuryAccrued(), ">= holds");

        uint256 got = esc.claimTreasury();
        assertEq(got, 40 * unit / 100, "the claim pays the accrual only, never the donation");
        esc.settle(consumer, provider, 100 * unit, exp, _sig(esc, CONSUMER_PK, 100 * unit, exp));   // drains the channel
        esc.claimTreasury();
        assertEq(tok.balanceOf(provider), 99 * unit, "provider paid exactly, donation not included");
        assertEq(tok.balanceOf(treasury), unit, "treasury paid exactly, donation not included");
        assertEq(esc.channelOf(consumer, provider), 0);
        vm.prank(consumer); vm.expectRevert(InsufficientBalance.selector);   // the donation is no channel
        esc.requestWithdraw(provider, 1);
        assertEq(tok.balanceOf(address(esc)), 10 * unit, "exactly the donations remain (no sweep, by design)");
    }

    /// A donation cannot be withdrawn by the donor or anyone else, cannot be claimed, and does not change any view.
    /// 捐赠不能被捐赠者或任何人提走或领取，也不改变任何查询结果。
    function test_directDonation_changesNoView() public {
        (Mal_DecimalsToken tok, TapeAPIEscrow esc) = _deploy(8);
        tok.mint(address(this), 5e8);
        tok.transfer(address(esc), 5e8);
        assertEq(esc.channelOf(address(this), provider), 0);
        assertEq(esc.claimedOf(address(this), provider), 0);
        assertEq(esc.treasuryAccrued(), 0);
        vm.expectRevert(ZeroAmount.selector);
        esc.claimTreasury();
        vm.expectRevert(InsufficientBalance.selector);
        esc.requestWithdraw(provider, 1);
    }
}
