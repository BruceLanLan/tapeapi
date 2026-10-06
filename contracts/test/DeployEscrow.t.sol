// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {Deploy} from "../script/Deploy.s.sol";

/// Fork rehearsal of the escrow pre-flight in script/Deploy.s.sol against BNB Smart Chain. It runs ONLY the token /
/// treasury checks (`checkEscrowConfig`): the full `run()` cannot execute here, because this profile's EVM is `paris`
/// and the chain's factory / hub use PUSH0 (that is what FOUNDRY_PROFILE=deploy exists for). Nothing is broadcast and
/// no key is used. Set BSC_RPC_URL to a read-only BNB Smart Chain endpoint to run it; without it every test skips.
/// 对 BNB 链分叉演练部署脚本的托管预检：只跑代币 / 金库检查（`checkEscrowConfig`）。完整 `run()` 在这里跑不了：本 profile
/// 的 EVM 是 paris，而链上工厂 / hub 用了 PUSH0。不广播、不用任何私钥。设置 BSC_RPC_URL（只读端点）即运行，未设则全部跳过。
/// @dev A plain token stand-in: code and `decimals()` are all the pre-flight reads. / 预检只读代码与 decimals() 的替身。
contract Preflight_PlainToken {
    function decimals() external pure returns (uint8) { return 18; }
}

contract DeployEscrowTest is Test {
    address constant USDT_PEG = 0x55d398326f99059fF775485246999027B3197955;
    address constant USDC_PEG_PROXY = 0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d;
    address constant HUB = 0xe61A9C7213a6Aa616C246a2B569e555B417b25ee;
    address constant FACTORY = 0x68224F668083c29e9800Be2a646d42d18cedF7e2;
    address constant TREASURY = address(0x7EA5);
    address constant DIRECTORY = address(0xD1EC);     // stands in for the ServiceDirectory this run would deploy
    address constant BINDING = address(0xB1D);        // stands in for a non-zero DOMAIN_BINDING
    bytes32 constant ZOS_SLOT = 0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3;
    string constant PROXY_MSG =
        "PREFLIGHT: TOKEN is a proxy (an EIP-1967 implementation / admin / beacon, EIP-1822 or legacy zOS slot is set): not admissible (TAPI-22 section 3.5 item 1). ALLOW_OTHER_TOKEN=true overrides this, rehearsals only.";

    Deploy s;

    function _fork() internal returns (bool) {
        string memory rpc = vm.envOr("BSC_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return false;
        }
        vm.createSelectFork(rpc);
        s = new Deploy();
        return true;
    }

    function test_fork_usdtPeg_passes() public {
        if (!_fork()) return;
        assertEq(USDT_PEG.codehash, s.CANONICAL_TOKEN_CODEHASH(), "the pinned code hash is the live one");
        s.checkEscrowConfig(USDT_PEG, TREASURY, HUB, FACTORY, address(0), DIRECTORY, false);
    }

    function test_fork_usdcPegProxy_fails() public {
        if (!_fork()) return;
        vm.expectRevert(bytes(
            "PREFLIGHT: TOKEN is a proxy (an EIP-1967 implementation / admin / beacon, EIP-1822 or legacy zOS slot is set): not admissible (TAPI-22 section 3.5 item 1). ALLOW_OTHER_TOKEN=true overrides this, rehearsals only."
        ));
        s.checkEscrowConfig(USDC_PEG_PROXY, TREASURY, HUB, FACTORY, address(0), DIRECTORY, false);
    }

    function test_fork_treasuryEqualsToken_fails() public {
        if (!_fork()) return;
        vm.expectRevert(bytes("PREFLIGHT: TREASURY is TOKEN -- a claim would send the accrual to the token contract"));
        s.checkEscrowConfig(USDT_PEG, USDT_PEG, HUB, FACTORY, address(0), DIRECTORY, false);
    }

    function test_fork_treasuryHubFactoryZero_fail() public {
        if (!_fork()) return;
        vm.expectRevert(bytes("PREFLIGHT: TREASURY is HUB"));
        s.checkEscrowConfig(USDT_PEG, HUB, HUB, FACTORY, address(0), DIRECTORY, false);
        vm.expectRevert(bytes("PREFLIGHT: TREASURY is FACTORY"));
        s.checkEscrowConfig(USDT_PEG, FACTORY, HUB, FACTORY, address(0), DIRECTORY, false);
        vm.expectRevert(bytes("PREFLIGHT: TREASURY is the zero address"));
        s.checkEscrowConfig(USDT_PEG, address(0), HUB, FACTORY, address(0), DIRECTORY, false);
    }

    /// The canonical address with different code (here: the code etched over it) fails the pin, override or not.
    function test_fork_canonicalAddressWithOtherCode_fails() public {
        if (!_fork()) return;
        vm.etch(USDT_PEG, USDC_PEG_PROXY.code);
        vm.expectRevert(bytes(
            "PREFLIGHT: TOKEN is the canonical USDT-peg address but its code hash is not the pinned one -- wrong chain or fork state; do not deploy"
        ));
        s.checkEscrowConfig(USDT_PEG, TREASURY, HUB, FACTORY, address(0), DIRECTORY, true);
    }

    /// Any other token needs ALLOW_OTHER_TOKEN=true; with it, a non-proxy token in [8, 18] decimals passes.
    function test_fork_otherToken_needsOverride() public {
        if (!_fork()) return;
        address wbnb = 0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c;   // not a proxy, 18 decimals
        vm.expectRevert(bytes(
            "PREFLIGHT: TOKEN is not the canonical USDT-peg 0x55d398326f99059fF775485246999027B3197955. Set ALLOW_OTHER_TOKEN=true only for an instance that passed its own TAPI-22 section 3.5 evaluation."
        ));
        s.checkEscrowConfig(wbnb, TREASURY, HUB, FACTORY, address(0), DIRECTORY, false);
        s.checkEscrowConfig(wbnb, TREASURY, HUB, FACTORY, address(0), DIRECTORY, true);
    }

    // ---- no fork needed: a local token stand-in with code and decimals() (the "other token" path) ----
    // ---- 无需分叉：本地替身代币（带代码与 decimals()，走"其它代币"路径）----

    /// The legacy zOS implementation slot (keccak256("org.zeppelinos.proxy.implementation")) marks a proxy exactly
    /// like the four EIP-1967 / EIP-1822 slots do: refused, unless ALLOW_OTHER_TOKEN (then it passes, with a warning).
    /// 旧 zOS 实现槽与 EIP-1967 / EIP-1822 四个槽一样标记代理：拒绝，除非 ALLOW_OTHER_TOKEN（放行并告警）。
    function test_zosSlot_marksAProxy() public {
        Deploy d = new Deploy();
        address tok = address(new Preflight_PlainToken());
        d.checkEscrowConfig(tok, TREASURY, HUB, FACTORY, address(0), DIRECTORY, true);   // control: not a proxy
        vm.store(tok, ZOS_SLOT, bytes32(uint256(uint160(0xBEEF))));
        vm.expectRevert(bytes(PROXY_MSG));
        d.checkEscrowConfig(tok, TREASURY, HUB, FACTORY, address(0), DIRECTORY, false);
        d.checkEscrowConfig(tok, TREASURY, HUB, FACTORY, address(0), DIRECTORY, true);   // override waives it
    }

    function test_treasury_notDomainBindingOrDirectory() public {
        Deploy d = new Deploy();
        address tok = address(new Preflight_PlainToken());
        d.checkEscrowConfig(tok, TREASURY, HUB, FACTORY, BINDING, DIRECTORY, true);      // control
        vm.expectRevert(bytes("PREFLIGHT: TREASURY is DOMAIN_BINDING"));
        d.checkEscrowConfig(tok, BINDING, HUB, FACTORY, BINDING, DIRECTORY, true);
        vm.expectRevert(bytes("PREFLIGHT: TREASURY is the ServiceDirectory this run deploys"));
        d.checkEscrowConfig(tok, DIRECTORY, HUB, FACTORY, BINDING, DIRECTORY, true);
        // a zero DOMAIN_BINDING (gate off) is not an address a treasury can "equal": the zero treasury is refused first
        vm.expectRevert(bytes("PREFLIGHT: TREASURY is the zero address"));
        d.checkEscrowConfig(tok, address(0), HUB, FACTORY, address(0), DIRECTORY, true);
    }

    // ---- on the fork ----

    /// The zOS slot is checked on the real canonical token too (set over the fork's state).
    function test_fork_zosSlotSet_fails() public {
        if (!_fork()) return;
        vm.store(USDT_PEG, ZOS_SLOT, bytes32(uint256(1)));
        vm.expectRevert(bytes(PROXY_MSG));
        s.checkEscrowConfig(USDT_PEG, TREASURY, HUB, FACTORY, address(0), DIRECTORY, false);
    }

    function test_fork_treasuryBindingOrDirectory_fail() public {
        if (!_fork()) return;
        vm.expectRevert(bytes("PREFLIGHT: TREASURY is DOMAIN_BINDING"));
        s.checkEscrowConfig(USDT_PEG, BINDING, HUB, FACTORY, BINDING, DIRECTORY, false);
        vm.expectRevert(bytes("PREFLIGHT: TREASURY is the ServiceDirectory this run deploys"));
        s.checkEscrowConfig(USDT_PEG, DIRECTORY, HUB, FACTORY, BINDING, DIRECTORY, false);
        s.checkEscrowConfig(USDT_PEG, TREASURY, HUB, FACTORY, BINDING, DIRECTORY, false);
    }

    /// No fork needed: with DRY_RUN unset and no --broadcast (always the case inside `forge test`), the mode line
    /// must not claim LIVE. / 无需分叉：DRY_RUN 未设且没有 --broadcast 时，模式一栏不得写 LIVE。
    function test_modeLabel_neverLiveWithoutBroadcast() public {
        Deploy d = new Deploy();
        assertEq(d.modeLabel(true), "DRY RUN (no broadcast)");
        string memory m = d.modeLabel(false);
        assertEq(m, "SIMULATION ONLY (DRY_RUN unset but no --broadcast: nothing will be sent)");
    }
}
