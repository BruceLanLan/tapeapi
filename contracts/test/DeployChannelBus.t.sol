// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {DeployChannelBus} from "../script/DeployChannelBus.s.sol";
import {ChannelBus} from "../src/ChannelBus.sol";

/// The deploy script's own checks run in a rehearsal: refuses a wrong chain, deploys and verifies on the right one.
/// 部署脚本的自检在演练中运行：链不对就拒绝，链对就部署并校验。
contract DeployChannelBusTest is Test {
    function test_refusesNonMainnetWithoutOverride() public {
        vm.chainId(97);
        DeployChannelBus s = new DeployChannelBus();
        vm.expectRevert(bytes("chain id is not 56 (set ALLOW_NON_MAINNET=true for a rehearsal)"));
        s.run();
    }

    function test_dryRunOnMainnetIdDeploysAndVerifies() public {
        vm.chainId(56);
        vm.setEnv("DRY_RUN", "true");
        ChannelBus bus = new DeployChannelBus().run();
        assertGt(address(bus).code.length, 0);
        assertEq(bus.MAX_WIRE(), 16_448);
    }
}
