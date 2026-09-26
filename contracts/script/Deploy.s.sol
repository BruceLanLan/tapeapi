// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

import {ServiceDirectory} from "../src/ServiceDirectory.sol";
import {TapeAPIEscrow} from "../src/TapeAPIEscrow.sol";
import {IDeWebHub, IFactory, IDomainBinding, IERC721} from "../src/interfaces.sol";

/// @dev Extra factory view used only to find a known-good processor for the pre-flight probe.
///      Not part of src/interfaces.sol because the contracts themselves never need it.
///      仅用于探针：从工厂取一个已知良好的处理器地址。合约本身不需要这个接口，故不放进 src。
interface IFactoryEnumerable {
    function cpus(uint256 index) external view returns (address);
    function cpuCount() external view returns (uint256);
}

/// @title TapeAPI mainnet deploy script / TapeAPI 主网部署脚本
/// @notice Deploys ServiceDirectory (always) and TapeAPIEscrow (opt-in) to BNB Smart Chain, with
///         hard pre-flight assertions before any state change and full post-deploy verification.
///         部署 ServiceDirectory（必选）与 TapeAPIEscrow（可选）到 BNB 智能链；写入前做硬断言，
///         写入后逐项校验。
///
/// Environment / 环境变量:
///   HUB              DeWebHub proxy, must have code                     必填，必须有代码
///   FACTORY          circuits factory, must have code                   必填，必须有代码
///   DOMAIN_BINDING   activation gate, 0 = disabled; non-zero must have code   0 表示关闭
///   BEM              BEM ERC-20, must have code (escrow only)           仅托管合约需要
///   TREASURY         escrow treasury, MAY be an EOA (escrow only)       可以是 EOA
///   DEPLOY_ESCROW    "true" to also deploy TapeAPIEscrow (default false)  默认不部署托管
///   DRY_RUN          "true" to simulate without broadcasting (default false)  默认非演练
///   PRIVATE_KEY      optional; otherwise pass --private-key / --account on the CLI
///   ALLOW_NON_MAINNET  "true" to permit a chain id other than 56 (anvil fork rehearsal only)
///   ALLOW_OTHER_HUB    "true" to permit a HUB other than the canonical one (testnet / fork only)
///                      允许非规范 HUB，仅用于测试网与分叉
///   EXPECT_SAMPLE_LIVE the expected isContainerLive(sample) answer from a non-zero DOMAIN_BINDING;
///                      default true, which is the value measured on mainnet on 2026-09-21
///                      非零 DOMAIN_BINDING 对样本容器应返回的激活状态，默认 true（2026-09-21 主网实测值）
///
/// Usage / 用法 (ALWAYS `forge build` under the default profile first / 必须先用默认 profile 构建):
///   forge build
///   DRY_RUN=true FOUNDRY_PROFILE=deploy forge script script/Deploy.s.sol --rpc-url $RPC
///   FOUNDRY_PROFILE=deploy forge script script/Deploy.s.sol --rpc-url $RPC --broadcast
///
/// FOUNDRY_PROFILE=deploy only raises the *simulation* EVM to shanghai (BNB Chain's own contracts
/// use PUSH0). The deployed bytes come from out-forge/, the audited paris / solc 0.8.28 build.
/// FOUNDRY_PROFILE=deploy 只把*模拟*用的 EVM 提到 shanghai（BNB 链合约使用 PUSH0）；
/// 上链字节仍取自 out-forge/ 的 paris / solc 0.8.28 审计构建。
contract Deploy is Script {
    // ---------- Expected mainnet constants (BNB Smart Chain, chainId 56) ----------
    uint256 internal constant MAINNET_CHAIN_ID = 56;

    /// @dev Known-good sample: circuit 4246 on the factory's processor #0 derives this container.
    ///      Verified live on chainId 56 on 2026-09-21. Used as an end-to-end probe that HUB and
    ///      FACTORY are the real contracts and agree with each other.
    ///      已知样本：工厂 0 号处理器的 4246 号电路推导出该容器（2026-09-21 主网核实）。
    uint256 internal constant PROBE_TOKEN_ID = 4246;
    uint256 internal constant PROBE_CPU_INDEX = 0;
    address internal constant PROBE_CONTAINER = 0x86DDaEF00401E3F10418398D67D7189fc458eA95;

    /// @dev TAP-20 §6.2 worked example: the ServiceDirectory delegation domain separator for
    ///      chainId 56 anchored on the canonical DeWebHub. An independent oracle for our recompute.
    ///      TAP-20 §6.2 算例：chainId 56 + 规范 DeWebHub 的委托域分隔符，作为独立对照。
    address internal constant CANONICAL_HUB = 0xe61A9C7213a6Aa616C246a2B569e555B417b25ee;
    bytes32 internal constant TAP20_DOMAIN_SEPARATOR =
        0xa73ee348b5672f12dbc174f66a7d162c69e0d64befdba88475d9d7e3c0fd3ac7;

    bytes32 internal constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    /// @dev TAP-20 §3.4's Delegation type, written out here rather than read from the deployed contract:
    ///      comparing `delegationDigest()` against a digest built from the contract's own
    ///      `DELEGATION_TYPEHASH()` would only prove the contract agrees with itself.
    ///      TAP-20 §3.4 的委托类型，在此独立写出而不从合约读取：用合约自己的 `DELEGATION_TYPEHASH()`
    ///      去比对 `delegationDigest()` 只能证明它自洽，不能证明它符合规范。
    bytes32 internal constant DELEGATION_TYPEHASH_EXPECTED =
        keccak256("Delegation(address container,address signer,uint64 expires)");

    /// @dev Throwaway key for the post-deploy delegation smoke test (pre-flight gap C). It is published
    ///      here on purpose: it holds nothing, it is never used to send a transaction, and the smoke test
    ///      is three `view` calls. Signing happens locally through the `pure` vm.sign cheatcode.
    ///      部署后委托冒烟测试用的一次性私钥（预检缺口 C）。刻意公开：它不持有任何资产，从不用于发送交易，
    ///      冒烟测试全部是 `view` 调用，签名经 `pure` 的 vm.sign 在本地完成。
    uint256 internal constant SMOKE_PRIVATE_KEY =
        0x5ec3e7a11e0b1a7c0d9f4e2b6a8c1d3f5e7a9b1c3d5f7a9b1c3d5f7a9b1c3d5f;

    uint256 internal constant EIP170_LIMIT = 24576;

    /// @dev The bytecode that actually goes on chain is read from these artifacts, NOT from
    ///      `new ServiceDirectory(...)`. This is deliberate: this script must run under
    ///      FOUNDRY_PROFILE=deploy (evm_version = shanghai) so the local simulation can execute the
    ///      PUSH0 in BNB Chain's own contracts, but the contracts we deploy must stay the audited
    ///      `paris` / solc 0.8.28 build that `forge test` exercised. Pinning the artifact path keeps
    ///      the two apart, and `_artifactCode` asserts the settings before a single byte is deployed.
    ///      真正上链的字节码来自这两个构建产物，而不是 `new ServiceDirectory(...)`：脚本需在
    ///      FOUNDRY_PROFILE=deploy（shanghai）下运行才能模拟 BNB 链合约里的 PUSH0，
    ///      但部署的必须是 `forge test` 验证过的 paris / solc 0.8.28 构建。
    string internal constant DIRECTORY_ARTIFACT = "out-forge/ServiceDirectory.sol/ServiceDirectory.json";
    string internal constant ESCROW_ARTIFACT = "out-forge/TapeAPIEscrow.sol/TapeAPIEscrow.json";
    string internal constant EXPECTED_EVM_VERSION = "paris";
    string internal constant EXPECTED_COMPILER = "0.8.28+commit.7893614a";

    // ---------- Resolved config / 解析后的配置 ----------
    address internal hub;
    address internal factory;
    address internal domainBinding;
    address internal bem;
    address internal treasury;
    address internal deployer;
    bool internal deployEscrow;
    bool internal dryRun;

    function run() external {
        _loadEnv();
        _preflight();
        (ServiceDirectory directory, TapeAPIEscrow escrow) = _deploy();
        _verifyDirectory(directory);
        if (deployEscrow) _verifyEscrow(escrow);
        _summary(directory, escrow);
    }

    // ---------------------------------------------------------------- env ----

    function _loadEnv() internal {
        hub = vm.envAddress("HUB");
        factory = vm.envAddress("FACTORY");
        // DOMAIN_BINDING is mandatory to SET but may legitimately be 0 (gate disabled).
        // It has no default on purpose: leaving the gate off must be a decision, not an oversight.
        // DOMAIN_BINDING 必须显式设置，但允许为 0（关闭门槛）。刻意不给默认值：关闭门槛应当是决定而非疏忽。
        domainBinding = vm.envAddress("DOMAIN_BINDING");

        deployEscrow = vm.envOr("DEPLOY_ESCROW", false);
        dryRun = vm.envOr("DRY_RUN", false);

        if (deployEscrow) {
            bem = vm.envAddress("BEM");
            treasury = vm.envAddress("TREASURY");
        }

        uint256 pk = vm.envOr("PRIVATE_KEY", uint256(0));
        deployer = pk == 0 ? msg.sender : vm.addr(pk);

        console2.log("=========================================================");
        console2.log(unicode"  TapeAPI deploy / TapeAPI 部署");
        console2.log("=========================================================");
        console2.log("  chain id        :", block.chainid);
        console2.log("  block number    :", block.number);
        console2.log("  deployer        :", deployer);
        console2.log("  deployer balance:", deployer.balance);
        console2.log("  mode            :", dryRun ? "DRY RUN (no broadcast)" : "LIVE (will broadcast)");
        console2.log("  deploy escrow   :", deployEscrow ? "yes" : "no  (ServiceDirectory only)");
        console2.log("---------------------------------------------------------");
        console2.log("  HUB             :", hub);
        console2.log("  FACTORY         :", factory);
        console2.log("  DOMAIN_BINDING  :", domainBinding);
        if (deployEscrow) {
            console2.log("  BEM             :", bem);
            console2.log("  TREASURY        :", treasury);
        }
        console2.log("---------------------------------------------------------");
    }

    // ----------------------------------------------------------- preflight ----

    function _preflight() internal view {
        // --- chain ---
        bool allowOther = vm.envOr("ALLOW_NON_MAINNET", false);
        if (!allowOther) {
            require(
                block.chainid == MAINNET_CHAIN_ID,
                "PREFLIGHT: block.chainid != 56 (not BNB Smart Chain mainnet). Set ALLOW_NON_MAINNET=true only for an anvil fork rehearsal."
            );
        } else if (block.chainid != MAINNET_CHAIN_ID) {
            console2.log("  !! ALLOW_NON_MAINNET set and chain id is not 56 -- REHEARSAL ONLY");
        }

        // --- hub identity (gap B) ---
        // The TAP-20 6.2 domain-separator comparison further down only runs when the hub is ALREADY
        // correct, so it is a consistency check, not a discriminator: a wrong hub skips it silently.
        // The sample-container probe below IS a discriminator, but a wrong hub is the single most
        // expensive mistake available here (it breaks both the container primary key and the
        // delegation signing domain, and it is immutable), so it gets an equals sign of its own.
        // 下面 TAP-20 §6.2 的域分隔符比对以"hub 已经正确"为前提，是自洽性检查而非判别器——hub 填错时
        // 整段被跳过。样本容器探针确实是判别器，但 hub 填错是这里代价最高的错误（同时破坏容器主键与
        // 委托签名域，且不可更改），因此再给它一个硬等号。
        bool allowOtherHub = vm.envOr("ALLOW_OTHER_HUB", false);
        require(
            hub == CANONICAL_HUB || allowOtherHub,
            "PREFLIGHT: HUB is not the canonical DeWebHub 0xe61A9C7213a6Aa616C246a2B569e555B417b25ee. Set ALLOW_OTHER_HUB=true only on a testnet or a fork."
        );
        if (hub != CANONICAL_HUB) {
            console2.log("  !! ALLOW_OTHER_HUB set and HUB is not the canonical hub -- REHEARSAL / TESTNET ONLY");
        }

        // --- code presence ---
        require(hub.code.length > 0, "PREFLIGHT: HUB has no code on this chain");
        require(factory.code.length > 0, "PREFLIGHT: FACTORY has no code on this chain");
        require(
            domainBinding == address(0) || domainBinding.code.length > 0,
            "PREFLIGHT: DOMAIN_BINDING is non-zero but has no code on this chain (use 0 to disable the gate)"
        );

        // --- semantic probe: DOMAIN_BINDING really is an IDomainBinding, and it answers as expected (gap A) ---
        // `code.length > 0` is not enough. A contract that has code but no `isContainerLive(address)`
        // makes `isLive` permanently false, which makes every label permanently unclaimable -- and the
        // directory is immutable, so the only fix is redeploying it. This has to fail here, not in the
        // first real user's `register`. Same two-sided shape as the isCPU probe above: one assertion
        // that the callee implements the interface, one that its ANSWER is the one operations expects.
        // 只检查"有代码"是不够的：一个有代码但没有 `isContainerLive(address)` 的合约会让 `isLive` 恒假，
        // 于是所有标签永久无法占用，而目录不可升级，唯一的补救是重新部署。这必须在这里失败，而不是在
        // 第一个真实用户的 `register` 里。形状与上面的 isCPU 双向探针一致：一条断言对方实现了该接口，
        // 一条断言对方给出的**答案**就是运维预期的那个。
        if (domainBinding != address(0)) {
            bool expectSampleLive = vm.envOr("EXPECT_SAMPLE_LIVE", true);
            // The gas cap makes a returndata bomb show up here rather than inside a user transaction.
            // ServiceDirectory.isLive itself only copies one word back (SD-01), but this script must be
            // able to survive a gate that the directory has not been pointed at yet.
            // gas 上限让 returndata 炸弹在预检里就暴露。目录的 isLive 只回拷一个字（SD-01），
            // 但本脚本必须能在"尚未把目录指向该门槛"的情况下活下来。
            (bool gateOk, bytes memory gateRet) = domainBinding.staticcall{gas: 200_000}(
                abi.encodeCall(IDomainBinding.isContainerLive, (PROBE_CONTAINER))
            );
            require(
                gateOk,
                "PREFLIGHT: DOMAIN_BINDING.isContainerLive(sample) reverted or ran out of gas -- not an IDomainBinding, or hostile"
            );
            require(
                gateRet.length == 32,
                "PREFLIGHT: DOMAIN_BINDING.isContainerLive(sample) returned an abnormal payload length -- not an IDomainBinding, or hostile"
            );
            uint256 gateWord = uint256(bytes32(gateRet));
            require(gateWord <= 1, "PREFLIGHT: DOMAIN_BINDING.isContainerLive(sample) returned a non-boolean word");
            require(
                gateWord == (expectSampleLive ? 1 : 0),
                "PREFLIGHT: DOMAIN_BINDING.isContainerLive(sample) != EXPECT_SAMPLE_LIVE -- the gate is not the one you think it is, or the sample container was deactivated"
            );
            console2.log("  domain binding  : isContainerLive(sample) ==", gateWord == 1 ? "true" : "false", "== EXPECT_SAMPLE_LIVE OK");
        } else {
            console2.log(unicode"  domain binding  : 0 -- activation gate PERMANENTLY DISABLED (immutable). Decision, not default? / 门槛永久关闭，确认这是决定而非默认");
        }
        if (deployEscrow) {
            require(bem.code.length > 0, "PREFLIGHT: BEM has no code on this chain");
            // TREASURY may be an EOA or a multisig; only the zero address is rejected (the
            // constructor would revert ZeroAddress anyway, but the message here is clearer).
            // TREASURY 可以是 EOA 或多签；只拒绝零地址。
            require(treasury != address(0), "PREFLIGHT: TREASURY is the zero address");
            if (treasury.code.length == 0) {
                console2.log(unicode"  note: TREASURY has no code (EOA). Intended? / TREASURY 是 EOA，确认是有意的");
            }
        }
        require(deployer != address(0), "PREFLIGHT: deployer is the zero address (pass --private-key / --account / --sender)");

        // --- live probe: the factory really is a factory ---
        // Every probe goes through _word(), which turns "the call reverted / returned nothing" into
        // a sentence instead of a bare EvmError. 每个探针都经 _word()，把裸 revert 变成可读的信息。
        uint256 cpuCount = _word(factory, abi.encodeCall(IFactoryEnumerable.cpuCount, ()), "FACTORY.cpuCount()");
        require(cpuCount > PROBE_CPU_INDEX, "PREFLIGHT: FACTORY.cpuCount() too small -- is this the circuits factory?");
        address processor = address(uint160(
            _word(factory, abi.encodeCall(IFactoryEnumerable.cpus, (PROBE_CPU_INDEX)), "FACTORY.cpus(0)")
        ));
        require(processor != address(0), "PREFLIGHT: FACTORY.cpus(0) returned the zero address");
        require(processor.code.length > 0, "PREFLIGHT: FACTORY.cpus(0) has no code");
        require(
            _word(factory, abi.encodeCall(IFactory.isCPU, (processor)), "FACTORY.isCPU(processor)") == 1,
            "PREFLIGHT: FACTORY.isCPU(FACTORY.cpus(0)) is false -- factory is inconsistent with itself"
        );
        // A processor the factory did not deploy must be rejected, otherwise the isCPU gate in
        // ServiceDirectory.register would be worthless. 反向探针：非工厂部署的地址必须为假。
        require(
            _word(factory, abi.encodeCall(IFactory.isCPU, (hub)), "FACTORY.isCPU(HUB)") == 0,
            "PREFLIGHT: FACTORY.isCPU(HUB) is true -- the isCPU gate does not discriminate, or FACTORY is not the circuits factory"
        );

        // --- live probe: the hub derives the container we already know ---
        address container = address(uint160(
            _word(hub, abi.encodeCall(IDeWebHub.accountOf, (processor, PROBE_TOKEN_ID)), "HUB.accountOf(processor, 4246)")
        ));
        require(container != address(0), "PREFLIGHT: HUB.accountOf(processor, 4246) returned the zero address");
        require(
            container == PROBE_CONTAINER,
            "PREFLIGHT: HUB.accountOf(cpus(0), 4246) != known sample container 0x86DDaEF00401E3F10418398D67D7189fc458eA95 -- wrong HUB, wrong FACTORY, or wrong chain"
        );

        console2.log("  probe processor :", processor);
        console2.log("  probe container :", container, "== known sample OK");
        console2.log("  factory cpus    :", cpuCount);

        // --- domain separator sanity, computed before anything is deployed ---
        bytes32 expected = _directoryDomainSeparator(hub);
        if (block.chainid == MAINNET_CHAIN_ID && hub == CANONICAL_HUB) {
            require(
                expected == TAP20_DOMAIN_SEPARATOR,
                "PREFLIGHT: recomputed directory DOMAIN_SEPARATOR != TAP-20 6.2 worked example"
            );
            console2.log("  domain sep      : matches TAP-20 6.2 worked example");
        }

        console2.log("  preflight       : ALL CHECKS PASSED");
        console2.log("---------------------------------------------------------");
    }

    // -------------------------------------------------------------- deploy ----

    function _deploy() internal returns (ServiceDirectory directory, TapeAPIEscrow escrow) {
        // Load and validate the creation bytecode BEFORE entering the broadcast, so a bad artifact
        // costs nothing. 先校验并加载创建字节码，再进入广播；产物不对时不会花掉任何 gas。
        bytes memory dirCode = _artifactCode(DIRECTORY_ARTIFACT, "ServiceDirectory");
        bytes memory escCode = deployEscrow ? _artifactCode(ESCROW_ARTIFACT, "TapeAPIEscrow") : bytes("");

        // Both constructors read msg.sender (owner, and the directory's initial treasury), so the
        // deployment MUST happen as `deployer`. In dry-run we prank instead of broadcasting so the
        // post-deploy assertions below check exactly the same thing they will check for real.
        // 两个构造函数都读取 msg.sender（owner，以及目录的初始 treasury），因此必须以 deployer 身份部署。
        // 演练模式用 prank 代替广播，使下面的断言与真实部署检查的内容完全一致。
        uint256 pk = vm.envOr("PRIVATE_KEY", uint256(0));
        if (dryRun) {
            vm.startPrank(deployer, deployer);
        } else if (pk != 0) {
            vm.startBroadcast(pk);
        } else {
            vm.startBroadcast();
        }

        uint256 gasBefore = gasleft();
        address dirAddr = _create(bytes.concat(dirCode, abi.encode(hub, factory, domainBinding)), "ServiceDirectory");
        uint256 gasDirectory = gasBefore - gasleft();
        directory = ServiceDirectory(dirAddr);

        uint256 gasEscrow;
        address escAddr;
        if (deployEscrow) {
            gasBefore = gasleft();
            escAddr = _create(bytes.concat(escCode, abi.encode(bem, hub, treasury)), "TapeAPIEscrow");
            gasEscrow = gasBefore - gasleft();
            escrow = TapeAPIEscrow(escAddr);
        }

        if (dryRun) vm.stopPrank();
        else vm.stopBroadcast();

        // This counts the CREATE opcode only, measured from inside the script. It runs ~57k HIGHER
        // than what the chain bills for the real deployment transaction, because a top-level
        // contract-creation transaction does not pay the CREATE opcode's own 32000, and this figure
        // does not include the 21000 intrinsic cost or the calldata cost of the initcode. Measured
        // on an anvil fork of mainnet on 2026-09-21: printed 1,745,012 here, receipt 1,688,297.
        // The receipt in broadcast/.../run-latest.json is the authoritative figure.
        // 这里只统计 CREATE 指令本身（在脚本内部测量），比链上真实部署交易的账单**高**约 5.7 万：
        // 顶层的合约创建交易不支付 CREATE 指令自身的 32000，而这个数字也不含 21000 固有 gas 与
        // initcode 的 calldata 费用。2026-09-21 anvil 主网分叉实测：此处打印 1,745,012，收据 1,688,297。
        // 以 broadcast/.../run-latest.json 里的收据为准。
        console2.log("  ServiceDirectory deployed:", dirAddr);
        console2.log("    gas, CREATE only        :", gasDirectory);
        if (deployEscrow) {
            console2.log("  TapeAPIEscrow deployed   :", escAddr);
            console2.log("    gas, CREATE only        :", gasEscrow);
        }
        console2.log("---------------------------------------------------------");
    }

    /// @dev Read a forge artifact, assert it is the audited build, and return its creation bytecode.
    ///      读取构建产物，断言它就是被审计的那一份，返回创建字节码。
    function _artifactCode(string memory path, string memory name) internal view returns (bytes memory code) {
        string memory json = vm.readFile(path);

        string memory evmVersion = vm.parseJsonString(json, ".metadata.settings.evmVersion");
        require(
            keccak256(bytes(evmVersion)) == keccak256(bytes(EXPECTED_EVM_VERSION)),
            string.concat(
                "ARTIFACT: ", name, " was built with evmVersion '", evmVersion, "', expected '", EXPECTED_EVM_VERSION,
                "'. Run `forge build` under the DEFAULT profile first (never FOUNDRY_PROFILE=deploy)."
            )
        );

        string memory compiler = vm.parseJsonString(json, ".metadata.compiler.version");
        require(
            keccak256(bytes(compiler)) == keccak256(bytes(EXPECTED_COMPILER)),
            string.concat(
                "ARTIFACT: ", name, " was built with solc ", compiler, ", expected ", EXPECTED_COMPILER
            )
        );

        code = vm.getCode(path);
        require(code.length > 0, string.concat("ARTIFACT: ", name, " has empty creation bytecode"));

        console2.log("  artifact        :", path);
        console2.log("    solc / evm    :", compiler, evmVersion);
        console2.log("    creation bytes:", code.length);
        console2.log("    runtime bytes :", vm.getDeployedCode(path).length);
    }

    /// @dev Plain CREATE of `initcode`. Used instead of `new X(...)` so the deployed bytes come from
    ///      the pinned artifact rather than from this script's own compilation profile.
    ///      直接 CREATE，而不是 `new X(...)`，确保上链字节来自固定的构建产物而非本脚本的编译 profile。
    function _create(bytes memory initcode, string memory name) internal returns (address addr) {
        assembly ("memory-safe") {
            addr := create(0, add(initcode, 0x20), mload(initcode))
        }
        require(addr != address(0), string.concat("DEPLOY: CREATE of ", name, " reverted (out of gas, or a constructor revert)"));
    }

    // -------------------------------------------------- post-deploy checks ----

    function _verifyDirectory(ServiceDirectory directory) internal view {
        address a = address(directory);
        require(a != address(0), "POST: ServiceDirectory address is zero");
        require(a.code.length > 0, "POST: ServiceDirectory has no code");
        require(a.code.length <= EIP170_LIMIT, "POST: ServiceDirectory exceeds the EIP-170 24576-byte limit");
        // Immutables are baked into the runtime code, so the bytes cannot be compared directly to the
        // artifact; the length can, and every immutable is checked individually just below.
        // 不可变量写死在运行时代码里，字节无法直接比对；长度可以，且每个不可变量都在下面逐项校验。
        require(
            a.code.length == vm.getDeployedCode(DIRECTORY_ARTIFACT).length,
            "POST: ServiceDirectory runtime code length != artifact -- wrong bytecode was deployed"
        );

        require(directory.owner() == deployer, "POST: ServiceDirectory.owner() != deployer");
        require(directory.pendingOwner() == address(0), "POST: ServiceDirectory.pendingOwner() != 0");
        require(directory.treasury() == deployer, "POST: ServiceDirectory.treasury() != deployer");
        require(address(directory.hub()) == hub, "POST: ServiceDirectory.hub() != HUB");
        require(address(directory.factory()) == factory, "POST: ServiceDirectory.factory() != FACTORY");
        require(address(directory.domainBinding()) == domainBinding, "POST: ServiceDirectory.domainBinding() != DOMAIN_BINDING");
        require(directory.labelFee() == 0, "POST: ServiceDirectory.labelFee() != 0");
        require(directory.count() == 0, "POST: ServiceDirectory.count() != 0");

        // The delegation domain is anchored on the HUB, not on the directory (see the contract's
        // note): every directory on a chain shares one delegation domain.
        // 委托域锚定在 HUB 而非目录合约本身。
        require(
            directory.DOMAIN_SEPARATOR() == _directoryDomainSeparator(hub),
            "POST: ServiceDirectory.DOMAIN_SEPARATOR() != keccak256(EIP712Domain, 'TapeAPI', '1', chainid, HUB)"
        );

        // The activation gate must answer without reverting either way, and its answer is asserted in
        // BOTH branches. Printing it in the gate-on branch (as this used to do) meant a directory whose
        // labels can never be claimed would deploy green and leave one line in a log.
        // 激活门槛在任何情况下都不得回滚，且**两个分支**都要断言它的答案。此前门槛开启时只把结果打印
        // 出来，于是"标签永远无法占用"的目录会一路全绿地部署完，只在日志里留下一行。
        bool live = directory.isLive(PROBE_CONTAINER);
        if (domainBinding == address(0)) {
            require(live, "POST: isLive() must be true when the gate is disabled");
        } else {
            require(
                live == vm.envOr("EXPECT_SAMPLE_LIVE", true),
                "POST: isLive(sample) != EXPECT_SAMPLE_LIVE -- labels would be unclaimable through THIS directory"
            );
        }

        // --- delegation smoke test (pre-flight gap C) ---
        // Nothing is broadcast here: vm.sign and vm.addr are pure cheatcodes and every call below is a
        // view. The full positive path needs a real circuit holder's private key, which we do not have,
        // so this asserts the two halves we can: that the digest the contract hands out is the TAP-20
        // §3.4 construction recomputed from first principles, and that a technically perfect signature
        // from someone who is NOT the circuit holder is refused. The negative case is the valuable one:
        // it runs accountOf -> ownerOf -> ecrecover -> holder comparison against the real hub and the
        // real circuits contract, so a misconfigured delegation chain cannot survive it.
        // 这里不广播任何交易：vm.sign / vm.addr 是 pure cheatcode，下面全部是 view 调用。完整的正向路径
        // 需要真实电路持有人的私钥（我们没有），因此断言可以断言的两半：合约给出的摘要等于按 TAP-20 §3.4
        // 从头重算的构造，以及一个**非持有人**给出的、格式完全正确的签名必须被拒绝。后者才是有价值的：
        // 它对着真实的 hub 与真实的电路合约跑完 accountOf -> ownerOf -> ecrecover -> 持有人比对。
        address processor = address(uint160(
            _word(factory, abi.encodeCall(IFactoryEnumerable.cpus, (PROBE_CPU_INDEX)), "FACTORY.cpus(0)")
        ));
        address smokeSigner = vm.addr(SMOKE_PRIVATE_KEY);
        uint64 smokeExpires = uint64(block.timestamp + 1 hours);

        // The negative assertion below is only worth making if the verifier can reach a real holder
        // at all: `verifyDelegation` returns false for a broken hub, a broken factory or a wrong
        // digest just as readily as it does for a genuine non-holder, so "it said false" on its own
        // proves nothing. Pin down that the sample circuit HAS an owner and that it is not the
        // throwaway key, and the false becomes a statement about the delegation path.
        // 下面那条否定断言只有在"验证器确实能取到真实持有人"时才有意义：hub 坏了、factory 坏了、
        // 摘要算错了，`verifyDelegation` 同样返回 false。先确认样本电路确实有持有人、且不是这把
        // 一次性私钥，那个 false 才是在陈述委托链路的状态。
        address probeHolder = address(uint160(
            _word(processor, abi.encodeCall(IERC721.ownerOf, (PROBE_TOKEN_ID)), "circuits.ownerOf(4246)")
        ));
        require(
            probeHolder != address(0),
            "POST: circuits.ownerOf(4246) is the zero address -- verifyDelegation's negative answer would prove nothing"
        );
        require(probeHolder != smokeSigner, "POST: the throwaway smoke key collided with the real circuit holder");

        require(
            directory.DELEGATION_TYPEHASH() == DELEGATION_TYPEHASH_EXPECTED,
            "POST: DELEGATION_TYPEHASH() != keccak256('Delegation(address container,address signer,uint64 expires)')"
        );
        bytes32 smokeDigest = keccak256(
            abi.encodePacked(
                hex"1901",
                _directoryDomainSeparator(hub),
                keccak256(abi.encode(DELEGATION_TYPEHASH_EXPECTED, PROBE_CONTAINER, smokeSigner, smokeExpires))
            )
        );
        require(
            directory.delegationDigest(PROBE_CONTAINER, smokeSigner, smokeExpires) == smokeDigest,
            "POST: delegationDigest() != the TAP-20 3.4 EIP-712 digest recomputed independently here"
        );

        (uint8 sv, bytes32 sr, bytes32 ss) = vm.sign(SMOKE_PRIVATE_KEY, smokeDigest);
        bytes memory smokeSig = abi.encodePacked(sr, ss, sv);
        require(smokeSig.length == 65, "POST: smoke signature is not 65 bytes");
        require(
            !directory.verifyDelegation(processor, PROBE_TOKEN_ID, smokeSigner, smokeExpires, smokeSig),
            "POST: verifyDelegation endorsed a valid signature from a signer the circuit holder never authorised"
        );
        console2.log("    probe holder    :", probeHolder);

        console2.log("  ServiceDirectory post-deploy checks: ALL PASSED");
        console2.log("    owner            :", directory.owner());
        console2.log("    treasury         :", directory.treasury());
        console2.log("    hub              :", address(directory.hub()));
        console2.log("    factory          :", address(directory.factory()));
        console2.log("    domainBinding    :", address(directory.domainBinding()));
        console2.log("    labelFee         :", directory.labelFee());
        console2.log("    runtime code size:", a.code.length);
        console2.logBytes32(directory.DOMAIN_SEPARATOR());
        console2.log("    (above: DOMAIN_SEPARATOR)");
        console2.log("    isLive(sample)   :", live ? "true" : "false");
        console2.log("    delegation smoke : digest matches TAP-20 3.4; real holder found; non-holder signature refused");
        console2.log("---------------------------------------------------------");
    }

    function _verifyEscrow(TapeAPIEscrow escrow) internal view {
        address a = address(escrow);
        require(a != address(0), "POST: TapeAPIEscrow address is zero");
        require(a.code.length > 0, "POST: TapeAPIEscrow has no code");
        require(a.code.length <= EIP170_LIMIT, "POST: TapeAPIEscrow exceeds the EIP-170 24576-byte limit");
        require(
            a.code.length == vm.getDeployedCode(ESCROW_ARTIFACT).length,
            "POST: TapeAPIEscrow runtime code length != artifact -- wrong bytecode was deployed"
        );

        require(escrow.owner() == deployer, "POST: TapeAPIEscrow.owner() != deployer");
        require(escrow.pendingOwner() == address(0), "POST: TapeAPIEscrow.pendingOwner() != 0");
        require(escrow.treasury() == treasury, "POST: TapeAPIEscrow.treasury() != TREASURY");
        require(address(escrow.bem()) == bem, "POST: TapeAPIEscrow.bem() != BEM");
        require(address(escrow.hub()) == hub, "POST: TapeAPIEscrow.hub() != HUB");

        // v2 (per-provider channels, DECISION-escrow-v2.md): the provider's protection is the cooldown.
        // v2（按提供者分账）：提供者的保护就是这个冷静期。
        require(escrow.WITHDRAW_COOLDOWN() == 48 hours, "POST: WITHDRAW_COOLDOWN != 48h");
        require(escrow.WITHDRAW_WINDOW() == 7 days, "POST: WITHDRAW_WINDOW != 7d");
        require(escrow.MAX_SESSION() == 30 days, "POST: MAX_SESSION != 30d");
        require(escrow.MAX_CONTRIBUTION_BPS() == 5000, "POST: MAX_CONTRIBUTION_BPS != 5000");

        // Unlike the directory, the escrow's voucher domain is anchored on the escrow itself.
        // 与目录不同，托管的凭证域锚定在托管合约自身。
        require(
            escrow.DOMAIN_SEPARATOR() == _escrowDomainSeparator(a),
            "POST: TapeAPIEscrow.DOMAIN_SEPARATOR() != keccak256(EIP712Domain, 'TapeAPIEscrow', '1', chainid, escrow)"
        );
        require(
            escrow.VOUCHER_TYPEHASH()
                == keccak256("Voucher(address consumer,address provider,uint256 cumulative,uint64 expires)"),
            "POST: VOUCHER_TYPEHASH mismatch"
        );

        // Fresh-state sanity / 初始状态
        require(escrow.channelOf(deployer, treasury) == 0, "POST: escrow channel not empty");
        require(escrow.claimedOf(deployer, treasury) == 0, "POST: escrow claimed not empty");

        console2.log("  TapeAPIEscrow post-deploy checks: ALL PASSED");
        console2.log("    owner            :", escrow.owner());
        console2.log("    treasury         :", escrow.treasury());
        console2.log("    bem              :", address(escrow.bem()));
        console2.log("    hub              :", address(escrow.hub()));
        console2.log("    MAX_SESSION      :", escrow.MAX_SESSION());
        console2.log("    WITHDRAW_COOLDOWN:", escrow.WITHDRAW_COOLDOWN());
        console2.log("    WITHDRAW_WINDOW  :", escrow.WITHDRAW_WINDOW());
        console2.log("    runtime code size:", a.code.length);
        console2.logBytes32(escrow.DOMAIN_SEPARATOR());
        console2.log("    (above: DOMAIN_SEPARATOR)");
        console2.log("---------------------------------------------------------");
    }

    // ------------------------------------------------------------- summary ----

    /// @dev Everything an operator needs to copy into the repo, BscScan and the SDK.
    ///      部署后需要抄回仓库 / BscScan / SDK 的全部内容。
    function _summary(ServiceDirectory directory, TapeAPIEscrow escrow) internal view {
        console2.log("");
        console2.log(unicode"=== COPY-PASTE BLOCK / 复制粘贴区 ===");
        console2.log("chainId=56");
        console2.log("ServiceDirectory=%s", address(directory));
        if (deployEscrow) console2.log("TapeAPIEscrow=%s", address(escrow));
        console2.log("hub=%s", hub);
        console2.log("factory=%s", factory);
        console2.log("domainBinding=%s", domainBinding);
        if (deployEscrow) {
            console2.log("bem=%s", bem);
            console2.log("treasury=%s", treasury);
        }
        console2.log("owner=%s", deployer);
        console2.log("");
        console2.log("--- constructor args, ABI-encoded for BscScan (no 0x prefix) ---");
        console2.log("ServiceDirectory(hub, factory, domainBinding):");
        console2.logBytes(abi.encode(hub, factory, domainBinding));
        if (deployEscrow) {
            console2.log("TapeAPIEscrow(bem, hub, treasury):");
            console2.logBytes(abi.encode(bem, hub, treasury));
        }
        console2.log("");
        console2.log(unicode"--- verification command / 验证命令 ---");
        console2.log("node scripts/verify-bscscan.mjs \\");
        console2.log("  --directory %s \\", address(directory));
        if (deployEscrow) console2.log("  --escrow %s \\", address(escrow));
        console2.log("  --hub %s --factory %s \\", hub, factory);
        console2.log("  --domain-binding %s", domainBinding);
        if (deployEscrow) console2.log("  --bem %s --treasury %s", bem, treasury);
        console2.log("=========================================================");
        if (dryRun) {
            console2.log("DRY RUN -- nothing was broadcast. Remove DRY_RUN to deploy.");
            console2.log(unicode"演练模式：未广播任何交易。");
        }
    }

    // ------------------------------------------------------------- helpers ----

    /// @dev One-word staticcall with a readable failure. A wrong address usually means "this
    ///      contract has no such function", which the EVM reports as a bare revert; `label` turns
    ///      that into something the operator can act on at 8am.
    ///      单字返回值的 staticcall，失败时给出可读信息：地址填错通常表现为裸 revert，
    ///      这里用 `label` 说明是哪一次调用出的问题。
    function _word(address target, bytes memory data, string memory label) internal view returns (uint256) {
        (bool success, bytes memory ret) = target.staticcall(data);
        require(success, string.concat("PREFLIGHT: ", label, " reverted -- wrong address, or not the contract you think it is"));
        require(ret.length >= 32, string.concat("PREFLIGHT: ", label, " returned fewer than 32 bytes -- wrong address or wrong ABI"));
        return uint256(bytes32(ret));
    }

    /// @dev ServiceDirectory delegation domain: anchored on the HUB / 锚定在 HUB
    function _directoryDomainSeparator(address hub_) internal view returns (bytes32) {
        return keccak256(
            abi.encode(EIP712_DOMAIN_TYPEHASH, keccak256("TapeAPI"), keccak256("1"), block.chainid, hub_)
        );
    }

    /// @dev TapeAPIEscrow voucher domain: anchored on the escrow itself / 锚定在托管合约自身
    function _escrowDomainSeparator(address escrow_) internal view returns (bytes32) {
        return keccak256(
            abi.encode(EIP712_DOMAIN_TYPEHASH, keccak256("TapeAPIEscrow"), keccak256("1"), block.chainid, escrow_)
        );
    }
}
