// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ChannelBus} from "../src/ChannelBus.sol";

/// The phone console (site/console) deploys the bytes in site/console/channelbus.json. They must be exactly the
/// contract this suite tests, creation and runtime code alike, or the page could deploy something untested.
/// 手机操作页（site/console）部署 site/console/channelbus.json 里的字节。它们必须与本测试套件测试的合约完全一致。
contract ConsoleBytecodeTest is Test {
    function test_consoleDeploysTheTestedContract() public view {
        string memory j = vm.readFile("../site/console/channelbus.json");
        assertEq(keccak256(vm.parseJsonBytes(j, ".creation")), keccak256(type(ChannelBus).creationCode), "creation code differs: run scripts/build-console.mjs");
        assertEq(keccak256(vm.parseJsonBytes(j, ".runtime")), keccak256(type(ChannelBus).runtimeCode), "runtime code differs: run scripts/build-console.mjs");
    }
}
