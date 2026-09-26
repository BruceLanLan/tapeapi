// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {ChannelBus} from "../src/ChannelBus.sol";

/// @title Deploy ChannelBus (TAP-26 §3.7) / 部署 ChannelBus
/// @notice ChannelBus has no constructor arguments, no owner and no state, so there is nothing to configure and
///         nothing to hand over afterwards. The deployer key only pays gas (about 265,000 gas measured: some 0.000013 BNB at 0.05 gwei).
///         无构造参数、无所有者、无状态：部署后没有任何需要配置或移交的东西，部署密钥只负责付 gas。
///
/// Environment / 环境变量:
///   DRY_RUN            "true" to simulate without broadcasting / 只模拟不广播
///   ALLOW_NON_MAINNET  "true" to permit a chain id other than 56 (fork or testnet rehearsal)
///
/// Usage / 用法:
///   forge build
///   DRY_RUN=true forge script script/DeployChannelBus.s.sol --rpc-url $RPC
///   forge script script/DeployChannelBus.s.sol --rpc-url $RPC --broadcast --ledger     (or --account / --private-key)
contract DeployChannelBus is Script {
    function run() external returns (ChannelBus bus) {
        if (block.chainid != 56) require(vm.envOr("ALLOW_NON_MAINNET", false), "chain id is not 56 (set ALLOW_NON_MAINNET=true for a rehearsal)");
        bool dry = vm.envOr("DRY_RUN", false);
        if (!dry) vm.startBroadcast();
        bus = new ChannelBus();
        if (!dry) vm.stopBroadcast();

        // Post-deploy checks: the bytes on chain are the contract we tested / 部署后校验：链上字节就是测试过的合约
        require(address(bus).code.length > 0, "no code at the new address");
        require(keccak256(address(bus).code) == keccak256(type(ChannelBus).runtimeCode), "runtime code differs from the build");
        require(bus.MAX_WIRE() == 16_448 && bus.MAX_BATCH() == 16, "constants differ from TAP-26 section 3.7");
        console2.log(dry ? "DRY RUN, not broadcast. ChannelBus would be at" : "ChannelBus deployed at", address(bus));
        console2.log("chain id", block.chainid);
    }
}
