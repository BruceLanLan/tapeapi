// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Tests added because a mutant of TapeAPIEscrow.sol SURVIVED the whole suite (docs/AUDIT-static.md, mutation
// table). Each test names the mutant it kills.
// 因变异体在整套测试下存活而补充的测试；每条注明它杀死的变异体。

import "forge-std/Test.sol";
import {TapeAPIEscrow} from "../src/TapeAPIEscrow.sol";
import {ZeroAddress, BadSignature} from "../src/interfaces.sol";
import {Mal_ERC20, Mal_ERC721, Mal_Hub, Mal_ZeroHub} from "./mocks/MaliciousTokens.sol";

contract MutationKillsTest is Test {
    Mal_ERC20 bem;
    Mal_ERC721 nft;
    address treasury = address(0x7EA5);
    address holder = address(0xA11CE);

    function setUp() public {
        vm.warp(1_758_300_000);
        bem = new Mal_ERC20();
        nft = new Mal_ERC721();
        nft.mint(holder, 1);
    }

    /// Kills M38 (drop `provider == address(0)` check in setContribution): a hub that derives no container must
    /// not let a holder write bps for address(0). The value written is not the default (100 since 2026-10-05), so a
    /// write would be visible in `contributionOf(address(0))`.
    /// 写入的值不是默认值（2026-10-05 起为 100），若被写入就会在 `contributionOf(address(0))` 中可见。
    function test_mut_M38_setContribution_zeroContainerReverts() public {
        TapeAPIEscrow esc = new TapeAPIEscrow(address(bem), address(new Mal_ZeroHub()), treasury);
        vm.prank(holder);
        vm.expectRevert(ZeroAddress.selector);
        esc.setContribution(address(nft), 1, 250);
        assertEq(esc.contributionOf(address(0)), esc.DEFAULT_CONTRIBUTION_BPS());
    }

    /// Kills M31 (drop `signer == address(0)` check in settle): an unrecoverable signature is BadSignature even
    /// when `consumer` is address(0) -- otherwise recover()'s failure value would "match" the consumer and the
    /// call would fall through to the balance checks.
    /// 无法恢复的签名即使 consumer 为零地址也必须是 BadSignature，否则 recover 的失败值会"匹配"consumer。
    function test_mut_M31_unrecoverableSignatureForZeroConsumerIsBadSignature() public {
        TapeAPIEscrow esc = new TapeAPIEscrow(address(bem), address(new Mal_Hub()), treasury);
        address provider = Mal_Hub(address(esc.hub())).accountOf(address(nft), 1);
        uint64 exp = uint64(block.timestamp + 1 hours);
        bytes memory garbage = new bytes(65);   // v = 0 -> 27, r = s = 0 -> ecrecover returns address(0)
        vm.expectRevert(BadSignature.selector);
        esc.settle(address(0), provider, 1, exp, garbage);
        bytes memory short = hex"1234";
        vm.expectRevert(BadSignature.selector);
        esc.settle(address(0), provider, 1, exp, short);
    }
}
