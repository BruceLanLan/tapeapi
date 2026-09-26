// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Split-settlement property (Balancer V2 rounding lesson, docs/research/RESEARCH-process-security.md 2.5 / 6.1 P0-2).
// Settling one cumulative C in N partial settles vs in one settle, on two otherwise identical channels:
//   consumer outflow   identical (Σ pay_i == pay_single == min(C, channel))
//   treasury_split  <= treasury_single                   (floor of a sum >= sum of floors)
//   0 <= provider_split − provider_single <= N − 1       (each floor loses < 1 unit, so at most N−1 in total)
// i.e. splitting can only move rounding dust from the treasury to the provider, never extract value from the
// consumer or the escrow, and never by more than N−1 base units.
// 分拆结算性质：同一 cumulative 拆成 N 笔 vs 一笔——消费者流出恒等；金库分拆 ≤ 一次；提供者多得 ∈ [0, N−1]。

import "forge-std/Test.sol";
import {TapeAPIEscrow} from "../src/TapeAPIEscrow.sol";
import {Mal_ERC20, Mal_ERC721, Mal_Hub} from "./mocks/MaliciousTokens.sol";

contract SplitSettlementTest is Test {
    Mal_ERC20 bem;
    Mal_ERC721 nft;
    Mal_Hub hub;
    TapeAPIEscrow escrow;
    address treasury = address(0x7EA5);
    address holder = address(0xA11CE);
    uint256 constant CONSUMER_PK = 0xC0FFEE;
    address consumer;
    address pSplit;
    address pSingle;
    uint256 constant MAX_N = 16;

    function setUp() public {
        vm.warp(1_758_300_000);
        consumer = vm.addr(CONSUMER_PK);
        bem = new Mal_ERC20();
        nft = new Mal_ERC721();
        hub = new Mal_Hub();
        nft.mint(holder, 1);
        nft.mint(holder, 2);
        pSplit = hub.accountOf(address(nft), 1);
        pSingle = hub.accountOf(address(nft), 2);
        escrow = new TapeAPIEscrow(address(bem), address(hub), treasury);
        vm.prank(consumer); bem.approve(address(escrow), type(uint256).max);
    }

    function _settle(address p, uint256 cum, uint64 exp) internal {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(CONSUMER_PK, escrow.voucherDigest(consumer, p, cum, exp));
        escrow.settle(consumer, p, cum, exp, abi.encodePacked(r, s, v));
    }

    /// @dev Strictly increasing cut points in [1, C-1] followed by C (duplicates dropped) / 严格递增的切分点，末项为 C
    function _cuts(uint256 C, uint256 n, uint256 seed) internal pure returns (uint256[] memory out, uint256 len) {
        uint256[] memory xs = new uint256[](n);
        uint256 m;
        for (uint256 i = 0; i + 1 < n && C > 1; i++) {
            uint256 x = bound(uint256(keccak256(abi.encode(seed, i))), 1, C - 1);
            uint256 j = m;
            while (j > 0 && xs[j - 1] > x) { xs[j] = xs[j - 1]; j--; }   // insertion sort / 插入排序
            xs[j] = x; m++;
        }
        out = new uint256[](m + 1);
        for (uint256 i = 0; i < m; i++) {
            if (len == 0 || xs[i] != out[len - 1]) out[len++] = xs[i];
        }
        out[len++] = C;
    }

    function testFuzz_splitSettlement_roundingOnlyMovesDustTreasuryToProvider(
        uint256 cSeed, uint256 nSeed, uint16 bpsSeed, uint256 chSeed, uint256 cutSeed
    ) public {
        uint256 C = bound(cSeed, 1, 1e18);
        uint256 n = bound(nSeed, 1, MAX_N);
        uint16 bps = uint16(bound(bpsSeed, 0, escrow.MAX_CONTRIBUTION_BPS()));
        // channel from well below C (credit flow, partial settles) to above it / 通道从远低于 C（赊账）到高于 C
        uint256 ch = bound(chSeed, 1, 2 * C);
        vm.startPrank(holder);
        escrow.setContribution(address(nft), 1, bps);
        escrow.setContribution(address(nft), 2, bps);
        vm.stopPrank();
        bem.mint(consumer, 2 * ch);
        vm.startPrank(consumer);
        escrow.fund(pSplit, ch);
        escrow.fund(pSingle, ch);
        vm.stopPrank();
        uint64 exp = uint64(block.timestamp + 1 days);

        // split / 分拆
        (uint256[] memory cuts, uint256 len) = _cuts(C, n, cutSeed);
        uint256 t0 = bem.balanceOf(treasury);
        uint256 settles;
        for (uint256 i = 0; i < len; i++) {
            if (escrow.channelOf(consumer, pSplit) == 0) break;   // credit flow: nothing left to pay from / 通道已空
            _settle(pSplit, cuts[i], exp);
            settles++;
        }
        uint256 treasurySplit = bem.balanceOf(treasury) - t0;
        uint256 providerSplit = bem.balanceOf(pSplit);

        // single / 一次
        uint256 t1 = bem.balanceOf(treasury);
        _settle(pSingle, C, exp);
        uint256 treasurySingle = bem.balanceOf(treasury) - t1;
        uint256 providerSingle = bem.balanceOf(pSingle);

        uint256 paid = C < ch ? C : ch;
        assertEq(escrow.channelOf(consumer, pSplit), escrow.channelOf(consumer, pSingle), "consumer outflow identical");
        assertEq(escrow.claimedOf(consumer, pSplit), paid, "split claimed == min(C, channel)");
        assertEq(escrow.claimedOf(consumer, pSingle), paid, "single claimed == min(C, channel)");
        assertEq(providerSplit + treasurySplit, providerSingle + treasurySingle, "total paid out identical");
        assertLe(treasurySplit, treasurySingle, "treasury_split <= treasury_single");
        assertGe(providerSplit, providerSingle, "provider_split >= provider_single");
        assertLe(providerSplit - providerSingle, settles - 1, "provider_split - provider_single <= N - 1");
        assertEq(treasurySingle, paid * bps / 10_000, "single contribution is floor(pay * bps / 1e4)");
        assertEq(bem.balanceOf(address(escrow)), escrow.channelOf(consumer, pSplit) + escrow.channelOf(consumer, pSingle));
    }

    /// The N−1 bound is tight: at 33.33% a 3-unit settle contributes floor(0.9999) = 0, so N such settles give the
    /// provider all 3N units, while one settle of 3N sends floor(0.9999 N) = N − 1 to the treasury.
    /// N−1 的上界是紧的：33.33% 下每笔 3 单位的贡献为 floor(0.9999) = 0；一次结算 3N 则贡献 N − 1。
    function test_splitSettlement_dustBoundIsTight() public {
        vm.prank(holder); escrow.setContribution(address(nft), 1, 3333);
        vm.prank(holder); escrow.setContribution(address(nft), 2, 3333);
        uint256 total = 3 * MAX_N;
        bem.mint(consumer, 2 * total);
        vm.startPrank(consumer);
        escrow.fund(pSplit, total);
        escrow.fund(pSingle, total);
        vm.stopPrank();
        uint64 exp = uint64(block.timestamp + 1 days);
        for (uint256 i = 1; i <= MAX_N; i++) _settle(pSplit, 3 * i, exp);
        _settle(pSingle, total, exp);
        assertEq(bem.balanceOf(pSplit), total, "every 3-unit contribution floors to 0");
        assertEq(bem.balanceOf(treasury), MAX_N - 1, "single settle contributes N - 1");
        assertEq(bem.balanceOf(pSplit) - bem.balanceOf(pSingle), MAX_N - 1, "difference reaches exactly N - 1");
    }
}
