// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Tests added because a mutant of TapeAPIEscrow.sol SURVIVED the whole suite (docs/AUDIT-static.md, mutation
// table). Each test names the mutant it kills.
// 因变异体在整套测试下存活而补充的测试；每条注明它杀死的变异体。

import "forge-std/Test.sol";
import {TapeAPIEscrow} from "../src/TapeAPIEscrow.sol";
import {ZeroAddress, BadSignature, NothingToSettle} from "../src/interfaces.sol";
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
    /// Second kill for R19's R9 (drop the high-s rejection in ECDSA.recover), which only
    /// test_A2_claim_signatureMalleabilityRejected killed. Here on the SESSION-KEY path, fuzzed key and amount: the
    /// high-s twin of a valid voucher signature must be BadSignature, and the canonical one settles exactly once.
    /// 第二道测试杀 R9（去掉高 s 拒绝）：会话密钥路径、模糊密钥与金额；合法签名的高 s 孪生必须 BadSignature。
    uint256 internal constant SECP_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;

    function testFuzz_mut_R9_highSTwin_sessionKeyVoucher_rejected(uint256 keySeed, uint256 amount) public {
        uint256 keyPk = bound(keySeed, 1, SECP_N - 1);
        amount = bound(amount, 1, 1_000 ether);
        address consumer = vm.addr(0xC0FFEE);
        vm.assume(vm.addr(keyPk) != consumer);
        (TapeAPIEscrow esc, address provider) = _sessionChannel(consumer, vm.addr(keyPk), amount);
        uint64 exp = uint64(block.timestamp + 1 hours);
        (bytes memory good, bytes memory twin) = _sigAndTwin(keyPk, esc.voucherDigest(consumer, provider, amount, exp));
        vm.expectRevert(BadSignature.selector);
        esc.settle(consumer, provider, amount, exp, twin);
        esc.settle(consumer, provider, amount, exp, good);
        assertEq(esc.claimedOf(consumer, provider), amount);
        vm.expectRevert(NothingToSettle.selector);
        esc.settle(consumer, provider, amount, exp, good);
    }

    function _sessionChannel(address consumer, address key, uint256 amount) internal returns (TapeAPIEscrow esc, address provider) {
        esc = new TapeAPIEscrow(address(bem), address(new Mal_Hub()), treasury);
        provider = Mal_Hub(address(esc.hub())).accountOf(address(nft), 1);
        bem.mint(consumer, amount);
        vm.startPrank(consumer);
        bem.approve(address(esc), amount);
        esc.fund(provider, amount);
        esc.authorizeSession(provider, key, uint64(block.timestamp + 1 days));
        vm.stopPrank();
    }

    function _sigAndTwin(uint256 pk, bytes32 digest) internal pure returns (bytes memory good, bytes memory twin) {
        (uint8 v, bytes32 r, bytes32 s_) = vm.sign(pk, digest);
        good = abi.encodePacked(r, s_, v);
        twin = abi.encodePacked(r, bytes32(SECP_N - uint256(s_)), v == 27 ? uint8(28) : uint8(27));
    }
}
