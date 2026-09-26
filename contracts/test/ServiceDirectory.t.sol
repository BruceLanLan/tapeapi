// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {ServiceDirectory} from "../src/ServiceDirectory.sol";
import {
    Service, NotOwner, NotPendingOwner, NotHolder, NotCPU, ServiceNotFound, LabelTaken, LabelNotFound, InsufficientFee,
    IndexOutOfBounds, NotLive, ZeroAddress
} from "../src/interfaces.sol";

// ---------- Mocks / 测试替身 ----------

/// @dev Lenient ERC-721: ownerOf returns address(0) for unknown tokens / 宽松实现：未知 token 返回零地址
contract MockERC721 {
    mapping(uint256 => address) public ownerOf;
    function mint(address to, uint256 id) external { ownerOf[id] = to; }
}

/// @dev OpenZeppelin-style ERC-721: ownerOf reverts for burned / non-existent tokens / OZ 风格：已销毁 token 回滚
contract MockERC721Strict {
    mapping(uint256 => address) private _owners;
    function mint(address to, uint256 id) external { _owners[id] = to; }
    function burn(uint256 id) external { delete _owners[id]; }
    function ownerOf(uint256 id) external view returns (address o) {
        o = _owners[id];
        require(o != address(0), "ERC721: invalid token ID");
    }
}

/// @dev Circuits factory with a settable allow-list / 可配置白名单的电路工厂
contract MockFactory {
    mapping(address => bool) public isCPU;
    function set(address circuits, bool v) external { isCPU[circuits] = v; }
}

contract MockHub {
    /// @dev deterministic pseudo ERC-6551 address / 确定性伪容器地址
    function accountOf(address circuits, uint256 tokenId) external pure returns (address) {
        return address(uint160(uint256(keccak256(abi.encode("container", circuits, tokenId)))));
    }
}

/// @dev DomainBinding with settable liveness; can be switched to the legacy "revert on unknown" behaviour.
///      可设置激活状态的 DomainBinding；可切换为旧实现的 "未知容器直接 revert" 行为。
contract MockDomainBinding {
    mapping(address => bool) public live;
    bool public revertMode;
    function setLive(address c, bool v) external { live[c] = v; }
    function setRevertMode(bool v) external { revertMode = v; }
    function isContainerLive(address c) external view returns (bool) {
        if (revertMode) revert("DomainBinding: unknown container");
        return live[c];
    }
}

/// @dev Answers every call with empty return data / 对任何调用返回空数据
contract MockDomainBindingEmpty {
    fallback() external {}
}

/// @dev Answers every call with arbitrary preset bytes (non-canonical bools, short data, trailing junk)
///      对任何调用返回预设的任意字节（非规范 bool、过短数据、尾部垃圾）
contract MockDomainBindingRaw {
    bytes public ret;
    function setRet(bytes calldata r) external { ret = r; }
    fallback() external {
        bytes memory r = ret;
        assembly { return(add(r, 32), mload(r)) }
    }
}

// ---------- Tests ----------

contract ServiceDirectoryTest is Test {
    MockERC721 nft;
    MockHub hub;
    MockFactory factory;
    ServiceDirectory dir;

    uint256 constant HOLDER_PK = 0xA11CE;
    uint256 constant OTHER_PK = 0xB0B;
    address holder;
    address other;
    address container;
    uint256 constant TOKEN = 4246;
    bytes32 constant LABEL = bytes32("reader");
    bytes32 constant LABEL2 = bytes32("reader2");
    string constant PATH = "/.well-known/tapeapi.json";
    address constant SIGNER = address(0x5167); // service signer / 服务签名地址

    event Registered(address indexed container, bytes32 indexed label, address circuits, uint256 tokenId, string manifestPath);
    event Updated(address indexed container, string manifestPath);
    event Released(address indexed container, bytes32 indexed label);
    event LabelFeeChanged(uint256 oldFee, uint256 newFee);
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    function setUp() public {
        holder = vm.addr(HOLDER_PK);
        other = vm.addr(OTHER_PK);
        nft = new MockERC721();
        hub = new MockHub();
        factory = new MockFactory();
        factory.set(address(nft), true);
        dir = new ServiceDirectory(address(hub), address(factory), address(0)); // no activation gate / 不启用激活门槛
        nft.mint(holder, TOKEN);
        container = hub.accountOf(address(nft), TOKEN);
        vm.deal(holder, 10 ether);
        vm.deal(other, 10 ether);
        vm.warp(1_758_300_000);
    }

    function _register(address who, bytes32 label, uint256 value) internal {
        vm.prank(who);
        dir.register{value: value}(address(nft), TOKEN, label, PATH);
    }

    // ----- constructor -----

    function test_constructor_zeroAddresses_revert() public {
        vm.expectRevert(ZeroAddress.selector);
        new ServiceDirectory(address(0), address(factory), address(0));
        vm.expectRevert(ZeroAddress.selector);
        new ServiceDirectory(address(hub), address(0), address(0));
        assertEq(address(dir.factory()), address(factory));
        assertEq(address(dir.hub()), address(hub));
    }

    // ----- D-01: only factory circuits / 仅工厂电路 -----

    function test_register_notCPU_reverts() public {
        MockERC721 fake = new MockERC721(); // home-made ERC-721 whose ownerOf says whatever we like / 自制 ERC-721
        fake.mint(other, 1);
        vm.prank(other);
        vm.expectRevert(NotCPU.selector);
        dir.register(address(fake), 1, LABEL, PATH);
        assertEq(dir.count(), 0);
        // allow-listing it makes the same call succeed / 加入白名单后同一调用成功
        factory.set(address(fake), true);
        vm.prank(other);
        dir.register(address(fake), 1, LABEL, PATH);
        assertEq(dir.resolve(LABEL), hub.accountOf(address(fake), 1));
        // de-listing blocks re-registration; update/release are not gated / 移出白名单后不能重登记；update/release 不受影响
        factory.set(address(fake), false);
        vm.prank(other);
        vm.expectRevert(NotCPU.selector);
        dir.register(address(fake), 1, LABEL, "/v2.json");
        vm.prank(other);
        dir.update(address(fake), 1, "/v2.json");
        vm.prank(other);
        dir.release(LABEL);
        assertEq(dir.resolve(LABEL), address(0));
    }

    // ----- register / resolve -----

    function test_register_noLabel_isFree() public {
        dir.setLabelFee(1 ether);
        vm.expectEmit(true, true, false, true);
        emit Registered(container, bytes32(0), address(nft), TOKEN, PATH);
        _register(holder, bytes32(0), 0);

        Service memory s = dir.serviceOf(container);
        assertEq(s.circuits, address(nft));
        assertEq(s.tokenId, TOKEN);
        assertEq(s.container, container);
        assertEq(s.label, bytes32(0));
        assertEq(s.manifestPath, PATH);
        assertEq(s.updatedAt, uint64(block.timestamp));
        assertEq(dir.count(), 1);
    }

    function test_register_withLabel_resolves() public {
        _register(holder, LABEL, 0);
        assertEq(dir.resolve(LABEL), container);
        assertEq(dir.serviceOf(container).label, LABEL);
    }

    function test_register_label_requiresFee() public {
        dir.setLabelFee(0.5 ether);
        vm.expectRevert(abi.encodeWithSelector(InsufficientFee.selector, 0.5 ether, 0.1 ether));
        _register(holder, LABEL, 0.1 ether);

        _register(holder, LABEL, 0.5 ether);
        assertEq(address(dir).balance, 0.5 ether);
        assertEq(dir.resolve(LABEL), container);
    }

    function test_register_notHolder_reverts() public {
        vm.expectRevert(NotHolder.selector);
        _register(other, LABEL, 0);
    }

    function test_register_labelConflict_reverts() public {
        _register(holder, LABEL, 0);
        // another circuit tries the same label / 另一电路尝试同一标签
        nft.mint(other, 7);
        vm.prank(other);
        vm.expectRevert(abi.encodeWithSelector(LabelTaken.selector, LABEL));
        dir.register(address(nft), 7, LABEL, PATH);
    }

    function test_reregister_sameLabel_updatesPath_noFee() public {
        _register(holder, LABEL, 0);
        dir.setLabelFee(1 ether); // fee raised after first claim / 之后涨价
        vm.warp(block.timestamp + 100);
        vm.prank(holder);
        dir.register(address(nft), TOKEN, LABEL, "/v2/tapeapi.json"); // no value, still ok
        Service memory s = dir.serviceOf(container);
        assertEq(s.manifestPath, "/v2/tapeapi.json");
        assertEq(s.label, LABEL);
        assertEq(dir.count(), 1); // not duplicated / 不重复计数
    }

    function test_reregister_switchLabel_freesOld() public {
        _register(holder, LABEL, 0);
        // D-04: the freed label is announced so indexers drop the stale mapping / 释放旧标签要发事件，索引器才会清理
        vm.expectEmit(true, true, false, true);
        emit Released(container, LABEL);
        vm.expectEmit(true, true, false, true);
        emit Registered(container, LABEL2, address(nft), TOKEN, PATH);
        _register(holder, LABEL2, 0);
        assertEq(dir.resolve(LABEL), address(0));
        assertEq(dir.resolve(LABEL2), container);
        // old label is claimable by someone else now / 旧标签可被他人占用
        nft.mint(other, 7);
        vm.prank(other);
        dir.register(address(nft), 7, LABEL, PATH);
        assertEq(dir.resolve(LABEL), hub.accountOf(address(nft), 7));
    }

    function test_register_afterTransfer_newHolderControls() public {
        _register(holder, LABEL, 0);
        nft.mint(other, TOKEN); // simulate transfer / 模拟转让
        vm.prank(holder);
        vm.expectRevert(NotHolder.selector);
        dir.update(address(nft), TOKEN, "/x");
        vm.prank(other);
        dir.update(address(nft), TOKEN, "/x");
        assertEq(dir.serviceOf(container).manifestPath, "/x");
    }

    // ----- update -----

    function test_update() public {
        _register(holder, LABEL, 0);
        vm.warp(block.timestamp + 5);
        vm.expectEmit(true, false, false, true);
        emit Updated(container, "/new.json");
        vm.prank(holder);
        dir.update(address(nft), TOKEN, "/new.json");
        Service memory s = dir.serviceOf(container);
        assertEq(s.manifestPath, "/new.json");
        assertEq(s.updatedAt, uint64(block.timestamp));
        assertEq(s.label, LABEL);
    }

    function test_update_notRegistered_reverts() public {
        vm.prank(holder);
        vm.expectRevert(ServiceNotFound.selector);
        dir.update(address(nft), TOKEN, "/x");
    }

    function test_update_notHolder_reverts() public {
        _register(holder, LABEL, 0);
        vm.prank(other);
        vm.expectRevert(NotHolder.selector);
        dir.update(address(nft), TOKEN, "/x");
    }

    // ----- release -----

    function test_release() public {
        _register(holder, LABEL, 0);
        vm.expectEmit(true, true, false, true);
        emit Released(container, LABEL);
        vm.prank(holder);
        dir.release(LABEL);
        assertEq(dir.resolve(LABEL), address(0));
        Service memory s = dir.serviceOf(container);
        assertEq(s.label, bytes32(0));
        assertEq(s.container, container); // record stays / 记录保留
        assertEq(dir.count(), 1);
    }

    function test_release_notHolder_reverts() public {
        _register(holder, LABEL, 0);
        vm.prank(other);
        vm.expectRevert(NotHolder.selector);
        dir.release(LABEL);
    }

    function test_release_unknownLabel_reverts() public {
        vm.prank(holder);
        vm.expectRevert(abi.encodeWithSelector(LabelNotFound.selector, LABEL));
        dir.release(LABEL);
    }

    // ----- D-02: burned tokens / 已销毁的电路 -----

    function test_release_burnedToken_anyoneCanRelease() public {
        MockERC721Strict strict = new MockERC721Strict();
        factory.set(address(strict), true);
        strict.mint(holder, TOKEN);
        address c = hub.accountOf(address(strict), TOKEN);
        vm.prank(holder);
        dir.register(address(strict), TOKEN, LABEL, PATH);
        // while the token exists only the holder may release / token 存在时仅持有人可释放
        vm.prank(other);
        vm.expectRevert(NotHolder.selector);
        dir.release(LABEL);

        strict.burn(TOKEN); // ownerOf now reverts / ownerOf 现在回滚
        // holder checks fail closed instead of bubbling the revert / 持有人检查失败关闭而非冒泡回滚
        vm.prank(holder);
        vm.expectRevert(NotHolder.selector);
        dir.register(address(strict), TOKEN, LABEL, PATH);
        vm.prank(holder);
        vm.expectRevert(NotHolder.selector);
        dir.update(address(strict), TOKEN, "/x");
        assertFalse(dir.verifyDelegation(address(strict), TOKEN, SIGNER, uint64(block.timestamp + 1 days),
            _sign(HOLDER_PK, dir.delegationDigest(c, SIGNER, uint64(block.timestamp + 1 days)))));
        // ...and anyone may free the label / 任何人都可以释放标签
        vm.prank(other);
        vm.expectEmit(true, true, false, true);
        emit Released(c, LABEL);
        dir.release(LABEL);
        assertEq(dir.resolve(LABEL), address(0));
        assertEq(dir.serviceOf(c).label, bytes32(0));
        // label is claimable again / 标签可再次被占用
        _register(holder, LABEL, 0);
        assertEq(dir.resolve(LABEL), container);
    }

    function test_release_zeroOwnerToken_anyoneCanRelease() public {
        // lenient ERC-721s report address(0) instead of reverting; same rule applies / 宽松实现返回零地址，规则相同
        _register(holder, LABEL, 0);
        nft.mint(address(0), TOKEN); // "burn"
        vm.prank(other);
        dir.release(LABEL);
        assertEq(dir.resolve(LABEL), address(0));
    }

    // ----- enumeration -----

    function test_count_at() public {
        _register(holder, LABEL, 0);
        nft.mint(other, 7);
        vm.prank(other);
        dir.register(address(nft), 7, bytes32(0), PATH);
        assertEq(dir.count(), 2);
        assertEq(dir.at(0).container, container);
        assertEq(dir.at(1).tokenId, 7);
        vm.expectRevert(IndexOutOfBounds.selector);
        dir.at(2);
    }

    // ----- admin / fees -----

    function test_setLabelFee_onlyOwner_emits() public {
        vm.expectEmit(false, false, false, true);
        emit LabelFeeChanged(0, 3);
        dir.setLabelFee(3);
        assertEq(dir.labelFee(), 3);
        vm.prank(other);
        vm.expectRevert(NotOwner.selector);
        dir.setLabelFee(4);
    }

    // E-07: two-step ownership on the directory too / 目录同样两步转移
    function test_transferOwnership_twoStep() public {
        vm.expectEmit(true, true, false, true);
        emit OwnershipTransferStarted(address(this), other);
        dir.transferOwnership(other);
        assertEq(dir.owner(), address(this));
        assertEq(dir.pendingOwner(), other);
        vm.prank(other);
        vm.expectRevert(NotOwner.selector);
        dir.setLabelFee(1);
        vm.prank(holder);
        vm.expectRevert(NotPendingOwner.selector);
        dir.acceptOwnership();
        vm.prank(other);
        vm.expectEmit(true, true, false, true);
        emit OwnershipTransferred(address(this), other);
        dir.acceptOwnership();
        assertEq(dir.owner(), other);
        assertEq(dir.pendingOwner(), address(0));
        vm.expectRevert(NotOwner.selector);
        dir.setLabelFee(1);
        vm.prank(other);
        dir.setLabelFee(1);
        assertEq(dir.labelFee(), 1);
    }

    function test_withdraw_toTreasury() public {
        dir.setLabelFee(1 ether);
        _register(holder, LABEL, 1.5 ether); // overpay is kept / 多付不退
        address treasury = makeAddr("treasury");
        dir.setTreasury(treasury);
        vm.prank(other); // anyone can trigger / 任何人可触发
        dir.withdraw();
        assertEq(treasury.balance, 1.5 ether);
        assertEq(address(dir).balance, 0);
    }

    // ----- activation gate / 激活门槛 -----

    function _gated() internal returns (ServiceDirectory g, MockDomainBinding b) {
        b = new MockDomainBinding();
        g = new ServiceDirectory(address(hub), address(factory), address(b));
    }

    function test_gate_disabledWithZeroAddress() public view {
        assertEq(address(dir.domainBinding()), address(0));
        assertTrue(dir.isLive(container)); // no gate -> always live / 未配置门槛恒为 true
    }

    function test_gate_labelRequiresLiveContainer() public {
        (ServiceDirectory g, MockDomainBinding b) = _gated();
        assertFalse(g.isLive(container));
        vm.prank(holder);
        vm.expectRevert(NotLive.selector);
        g.register(address(nft), TOKEN, LABEL, PATH);

        b.setLive(container, true);
        assertTrue(g.isLive(container));
        vm.prank(holder);
        g.register(address(nft), TOKEN, LABEL, PATH);
        assertEq(g.resolve(LABEL), container);
    }

    function test_gate_noLabelBypassesGate() public {
        (ServiceDirectory g,) = _gated();
        vm.prank(holder);
        g.register(address(nft), TOKEN, bytes32(0), PATH); // not live, but label 0 is fine / 未激活但无标签可登记
        assertEq(g.count(), 1);
        assertEq(g.serviceOf(container).container, container);
        vm.prank(holder);
        g.update(address(nft), TOKEN, "/v2.json"); // update never consults the gate / update 不查门槛
        assertEq(g.serviceOf(container).manifestPath, "/v2.json");
    }

    function test_gate_revertingBindingIsNotLive() public {
        (ServiceDirectory g, MockDomainBinding b) = _gated();
        b.setLive(container, true);
        b.setRevertMode(true); // older impls revert for unknown containers / 旧实现 revert
        assertFalse(g.isLive(container)); // treated as false, never bubbles / 视为 false，不冒泡
        vm.prank(holder);
        vm.expectRevert(NotLive.selector);
        g.register(address(nft), TOKEN, LABEL, PATH);
    }

    function test_gate_emptyReturnIsNotLive() public {
        MockDomainBindingEmpty empty = new MockDomainBindingEmpty();
        ServiceDirectory g = new ServiceDirectory(address(hub), address(factory), address(empty));
        assertFalse(g.isLive(container));
        vm.prank(holder);
        vm.expectRevert(NotLive.selector);
        g.register(address(nft), TOKEN, LABEL, PATH);
    }

    // D-03: only a 32-byte word equal to 1 counts as live; never a revert / 仅首字恰为 1 视为激活，绝不回滚
    function test_gate_nonCanonicalOrShortReturnIsNotLive() public {
        MockDomainBindingRaw raw = new MockDomainBindingRaw();
        ServiceDirectory g = new ServiceDirectory(address(hub), address(factory), address(raw));

        raw.setRet(abi.encode(uint256(2)));       // non-canonical bool: abi.decode would panic / 非规范 bool
        assertFalse(g.isLive(container));
        vm.prank(holder);
        vm.expectRevert(NotLive.selector);
        g.register(address(nft), TOKEN, LABEL, PATH);

        raw.setRet(hex"01");                       // short data / 数据过短
        assertFalse(g.isLive(container));
        raw.setRet(abi.encodePacked(uint240(0), uint8(1))); // 31 bytes ending in 1 / 31 字节
        assertFalse(g.isLive(container));
        raw.setRet(abi.encode(uint256(1) << 8));  // 0x100: not exactly 1 / 不是恰好 1
        assertFalse(g.isLive(container));
        raw.setRet(abi.encode(type(uint256).max));
        assertFalse(g.isLive(container));

        raw.setRet(abi.encode(true));              // canonical true / 规范 true
        assertTrue(g.isLive(container));
        raw.setRet(abi.encodePacked(uint256(1), uint256(0xdead))); // trailing junk is ignored / 忽略尾部数据
        assertTrue(g.isLive(container));
        vm.prank(holder);
        g.register(address(nft), TOKEN, LABEL, PATH);
        assertEq(g.resolve(LABEL), container);
    }

    function test_gate_deactivation_blocksRelabel_keepsRecordAndResolve() public {
        (ServiceDirectory g, MockDomainBinding b) = _gated();
        b.setLive(container, true);
        vm.prank(holder);
        g.register(address(nft), TOKEN, LABEL, PATH);
        b.setLive(container, false);
        // existing label keeps resolving; the gate is checked at registration only / 已有标签仍可解析，门槛只在登记时检查
        assertEq(g.resolve(LABEL), container);
        // re-registering with a label (even the same one) now fails; update/release still work
        // 带标签重登记（即使同一标签）失败；update/release 不受影响
        vm.prank(holder);
        vm.expectRevert(NotLive.selector);
        g.register(address(nft), TOKEN, LABEL, "/v2.json");
        vm.prank(holder);
        g.update(address(nft), TOKEN, "/v2.json");
        assertEq(g.serviceOf(container).manifestPath, "/v2.json");
        vm.prank(holder);
        g.release(LABEL);
        assertEq(g.resolve(LABEL), address(0));
    }

    function test_gate_withLabelFee_bothEnforced() public {
        (ServiceDirectory g, MockDomainBinding b) = _gated();
        g.setLabelFee(0.5 ether);
        b.setLive(container, true);
        vm.prank(holder);
        vm.expectRevert(abi.encodeWithSelector(InsufficientFee.selector, 0.5 ether, 0));
        g.register(address(nft), TOKEN, LABEL, PATH);
        vm.prank(holder);
        g.register{value: 0.5 ether}(address(nft), TOKEN, LABEL, PATH);
        assertEq(g.resolve(LABEL), container);
    }

    // ----- delegation (EIP-712) -----

    function _sign(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function test_domainSeparator_matchesSpec() public view {
        bytes32 expected = keccak256(abi.encode(
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256("TapeAPI"), keccak256("1"), block.chainid, address(hub)   // anchored on the hub, not the directory / 锚定中枢而非目录
        ));
        assertEq(dir.DOMAIN_SEPARATOR(), expected);
        assertEq(dir.DELEGATION_TYPEHASH(), keccak256("Delegation(address container,address signer,uint64 expires)"));
    }

    function test_verifyDelegation_pass() public view {
        address signer = SIGNER;
        uint64 expires = uint64(block.timestamp + 1 days);
        bytes32 digest = dir.delegationDigest(container, signer, expires);
        // independent digest computation / 独立计算摘要
        bytes32 manual = keccak256(abi.encodePacked("\x19\x01", dir.DOMAIN_SEPARATOR(),
            keccak256(abi.encode(dir.DELEGATION_TYPEHASH(), container, signer, expires))));
        assertEq(digest, manual);
        assertTrue(dir.verifyDelegation(address(nft), TOKEN, signer, expires, _sign(HOLDER_PK, digest)));
    }

    function test_verifyDelegation_acceptsV0or1() public view {
        address signer = SIGNER;
        uint64 expires = uint64(block.timestamp + 1 days);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(HOLDER_PK, dir.delegationDigest(container, signer, expires));
        assertTrue(dir.verifyDelegation(address(nft), TOKEN, signer, expires, abi.encodePacked(r, s, uint8(v - 27))));
    }

    function test_verifyDelegation_wrongSigner_fails() public view {
        address signer = SIGNER;
        uint64 expires = uint64(block.timestamp + 1 days);
        bytes memory sig = _sign(OTHER_PK, dir.delegationDigest(container, signer, expires));
        assertFalse(dir.verifyDelegation(address(nft), TOKEN, signer, expires, sig));
    }

    function test_verifyDelegation_expired_fails() public {
        address signer = SIGNER;
        uint64 expires = uint64(block.timestamp + 10);
        bytes memory sig = _sign(HOLDER_PK, dir.delegationDigest(container, signer, expires));
        assertTrue(dir.verifyDelegation(address(nft), TOKEN, signer, expires, sig));
        vm.warp(expires + 1);
        assertFalse(dir.verifyDelegation(address(nft), TOKEN, signer, expires, sig));
    }

    function test_verifyDelegation_tamperedFields_fail() public view {
        address signer = SIGNER;
        uint64 expires = uint64(block.timestamp + 1 days);
        bytes memory sig = _sign(HOLDER_PK, dir.delegationDigest(container, signer, expires));
        assertFalse(dir.verifyDelegation(address(nft), TOKEN, other, expires, sig));        // different signer
        assertFalse(dir.verifyDelegation(address(nft), TOKEN, signer, expires + 1, sig));   // different expiry
    }

    function test_verifyDelegation_afterTransfer_fails() public {
        address signer = SIGNER;
        uint64 expires = uint64(block.timestamp + 1 days);
        bytes memory sig = _sign(HOLDER_PK, dir.delegationDigest(container, signer, expires));
        nft.mint(other, TOKEN); // holder changed / 持有人变更后旧委托失效
        assertFalse(dir.verifyDelegation(address(nft), TOKEN, signer, expires, sig));
    }

    function test_verifyDelegation_malformedSig_fails() public view {
        address signer = SIGNER;
        uint64 expires = uint64(block.timestamp + 1 days);
        assertFalse(dir.verifyDelegation(address(nft), TOKEN, signer, expires, hex"1234"));
        assertFalse(dir.verifyDelegation(address(nft), TOKEN, signer, expires, new bytes(65)));
    }
}
