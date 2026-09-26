// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC721, IDeWebHub, IDomainBinding, IFactory, Service, Ownable, ECDSA} from "./interfaces.sol";
import {
    ZeroAddress, NotHolder, NotCPU, ServiceNotFound, LabelTaken, LabelNotFound, NotLive,
    InsufficientFee, IndexOutOfBounds, TransferFailed
} from "./interfaces.sol";

/// @title TapeAPI ServiceDirectory
/// @notice Registry of TapeAPI services (circuits) keyed by container; optional unique bytes32 label.
///         `circuits` must be a factory-deployed circuits contract (`factory.isCPU(circuits)`), so home-made
///         ERC-721s cannot register. Optional activation gate: when deployed with a DomainBinding address,
///         claiming a label requires `isContainerLive(container)` (activation fees go to the protocol, not here).
///         Not upgradeable. Owner only manages label fee (default 0) / treasury.
///         服务目录：以容器为主键登记服务，可选唯一 bytes32 标签。`circuits` 必须是工厂部署的电路合约
///         （`factory.isCPU(circuits)`），自制 ERC-721 无法登记。可选激活门槛：部署时传入 DomainBinding
///         地址后，占用标签需 `isContainerLive(container)` 为真（激活费付给协议，不付给本合约）。
///         不可升级，owner 仅管理标签费（默认 0）与国库。
contract ServiceDirectory is Ownable {
    // ---------- EIP-712 / 委托签名域 ----------
    bytes32 private constant _EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant _NAME_HASH = keccak256("TapeAPI");
    bytes32 private constant _VERSION_HASH = keccak256("1");
    /// @notice Delegation(address container,address signer,uint64 expires)
    bytes32 public constant DELEGATION_TYPEHASH =
        keccak256("Delegation(address container,address signer,uint64 expires)");

    uint256 private immutable _cachedChainId;
    bytes32 private immutable _cachedDomainSeparator;

    // ---------- Storage / 存储 ----------
    IDeWebHub public immutable hub;               // DeWebHub for accountOf / 容器推导
    IFactory public immutable factory;            // circuits factory: isCPU(circuits) gate / 电路工厂，isCPU 门槛
    IDomainBinding public immutable domainBinding; // address(0) = no activation gate / 零地址表示不启用激活门槛
    uint256 public labelFee;                      // BNB fee to claim a label, default 0 / 标签费用 (wei)，默认 0
    address public treasury;             // fee destination on withdraw() / 国库

    mapping(address container => Service) private _services;
    mapping(bytes32 label => address container) private _labels;
    address[] private _containers;                      // enumerable list / 枚举列表
    mapping(address container => uint256) private _indexPlusOne; // 1-based index into _containers

    // ---------- Events / 事件 ----------
    event Registered(address indexed container, bytes32 indexed label, address circuits, uint256 tokenId, string manifestPath);
    event Updated(address indexed container, string manifestPath);
    event Released(address indexed container, bytes32 indexed label);
    event LabelFeeChanged(uint256 oldFee, uint256 newFee);
    event TreasuryChanged(address indexed oldTreasury, address indexed newTreasury);
    event Withdrawn(address indexed treasury, uint256 amount);

    /// @param hub_ DeWebHub proxy / 容器推导合约
    /// @param factory_ circuits factory exposing `isCPU(address)`; non-zero / 电路工厂（提供 `isCPU`），非零
    /// @param domainBinding_ DomainBinding for the activation gate, or address(0) to disable / 激活门槛合约，零地址关闭
    constructor(address hub_, address factory_, address domainBinding_) {
        if (hub_ == address(0) || factory_ == address(0)) revert ZeroAddress();
        hub = IDeWebHub(hub_);
        factory = IFactory(factory_);
        domainBinding = IDomainBinding(domainBinding_);
        treasury = msg.sender;
        _cachedChainId = block.chainid;
        _cachedDomainSeparator = _buildDomainSeparator();
    }

    // ---------- Registration / 登记 ----------

    /// @notice Register or re-register a service. `circuits` must pass `factory.isCPU` and the caller must hold
    ///         the circuit (a burned / non-existent token has no holder and reverts NotHolder()).
    ///         登记/重登记服务；`circuits` 必须通过 `factory.isCPU`，调用者必须是电路持有人（已销毁 / 不存在的
    ///         token 没有持有人，回滚 NotHolder()）。label==0 免费；新占标签需付 labelFee。
    /// @dev Same-container re-register with the same label costs nothing and just updates manifestPath.
    ///      Switching label frees the previous one and emits Released(container, oldLabel).
    ///      Excess msg.value is kept for the treasury.
    ///      With a non-zero label and an activation gate configured, the container must be live.
    ///      切换标签会释放旧标签并发出 Released(container, oldLabel)。带非零标签且启用激活门槛时，容器必须处于已激活状态。
    function register(address circuits, uint256 tokenId, bytes32 label, string calldata manifestPath) external payable {
        if (!factory.isCPU(circuits)) revert NotCPU();
        if (_holderOf(circuits, tokenId) != msg.sender) revert NotHolder();
        address container = hub.accountOf(circuits, tokenId);
        if (container == address(0)) revert ZeroAddress();

        Service storage svc = _services[container];
        bytes32 oldLabel = svc.label;

        if (label != bytes32(0)) {
            if (address(domainBinding) != address(0) && !isLive(container)) revert NotLive();
            address holder = _labels[label];
            if (holder != address(0) && holder != container) revert LabelTaken(label);
            if (holder == address(0)) {
                // newly claimed label -> fee / 新占标签需付费
                if (msg.value < labelFee) revert InsufficientFee(labelFee, msg.value);
                _labels[label] = container;
            }
        }
        // free previous label if changed / 标签变更时释放旧标签
        if (oldLabel != bytes32(0) && oldLabel != label) {
            delete _labels[oldLabel];
            emit Released(container, oldLabel);
        }

        if (_indexPlusOne[container] == 0) {
            _containers.push(container);
            _indexPlusOne[container] = _containers.length;
        }

        svc.circuits = circuits;
        svc.tokenId = tokenId;
        svc.container = container;
        svc.label = label;
        svc.manifestPath = manifestPath;
        svc.updatedAt = uint64(block.timestamp);

        emit Registered(container, label, circuits, tokenId, manifestPath);
    }

    /// @notice Update manifest path only / 仅更新清单路径
    function update(address circuits, uint256 tokenId, string calldata manifestPath) external {
        // SD-03, deliberately NOT gated by `factory.isCPU`. A record can only exist if `register` created
        // it, and `register` is gated, so there is no path by which an unauthentic circuit reaches this
        // function -- it reverts `ServiceNotFound` below. Adding the gate here would buy nothing and would
        // freeze manifest updates for a legitimate service if its processor ever left the factory's list.
        // SD-03：此处刻意不加 `factory.isCPU` 门槛。记录只能由带门槛的 `register` 创建，
        // 因此不存在非真实电路抵达本函数的路径（下方会以 `ServiceNotFound` 回滚）。
        // 在此加门槛毫无收益，却会在处理器一旦离开工厂名单时冻结正当服务的清单更新。
        if (_holderOf(circuits, tokenId) != msg.sender) revert NotHolder();
        address container = hub.accountOf(circuits, tokenId);
        Service storage svc = _services[container];
        if (svc.container == address(0)) revert ServiceNotFound();
        svc.manifestPath = manifestPath;
        svc.updatedAt = uint64(block.timestamp);
        emit Updated(container, manifestPath);
    }

    /// @notice Holder gives up a label; service record stays with label=0. If the circuit no longer has a holder
    ///         (token burned: `ownerOf` reverts or returns address(0)) anyone may release the label.
    ///         持有人放弃标签，服务记录保留。若电路已无持有人（token 已销毁：`ownerOf` 回滚或返回零地址），任何人可释放。
    function release(bytes32 label) external {
        address container = _labels[label];
        if (container == address(0)) revert LabelNotFound(label);
        Service storage svc = _services[container];
        address holder = _holderOf(svc.circuits, svc.tokenId);
        if (holder != address(0) && holder != msg.sender) revert NotHolder();
        delete _labels[label];
        svc.label = bytes32(0);
        svc.updatedAt = uint64(block.timestamp);
        emit Released(container, label);
    }

    // ---------- Views / 查询 ----------

    /// @notice label -> container (address(0) if unassigned) / 标签解析
    function resolve(bytes32 label) external view returns (address container) {
        return _labels[label];
    }

    /// @notice Service record of a container (empty struct if none) / 容器的服务记录
    function serviceOf(address container) external view returns (Service memory) {
        return _services[container];
    }

    /// @notice Number of registered containers / 已登记容器数量
    function count() external view returns (uint256) {
        return _containers.length;
    }

    /// @notice i-th registered service / 第 i 个服务
    function at(uint256 i) external view returns (Service memory) {
        if (i >= _containers.length) revert IndexOutOfBounds();
        return _services[_containers[i]];
    }

    /// @notice Activation status per DomainBinding. True when no gate is configured. Live iff the call succeeds,
    ///         returns at least 32 bytes and the first word is exactly 1; a revert, short data or any other word
    ///         (e.g. 0x02) is "not live", never a revert of this contract.
    ///         按 DomainBinding 判断激活状态；未配置门槛时恒为 true。仅当调用成功、返回 ≥ 32 字节且首字恰为 1 时视为已激活；
    ///         revert、数据过短或其它值（如 0x02）一律视为未激活，本合约不因此回滚。
    function isLive(address container) public view returns (bool) {
        if (address(domainBinding) == address(0)) return true;
        // SD-01: copy at most one word back. `bytes memory ret` copies ALL returndata, so an upgraded or
        // hostile gate could return tens of thousands of words and make this view -- and therefore
        // `register` -- run out of gas, permanently blocking label claims. The gate is a UUPS proxy owned
        // by an EOA that is not ours, so bounding the copy is the only durable defence.
        // SD-01：最多只回拷一个字。`bytes memory ret` 会拷回全部返回数据，被升级或恶意的门槛合约
        // 可以返回数万个字，使本视图乃至 `register` 耗尽 gas，永久阻断标签登记。该门槛是由非我方 EOA
        // 持有的 UUPS 代理，限制回拷长度是唯一持久的防御。
        bytes memory input = abi.encodeCall(IDomainBinding.isContainerLive, (container));
        address gate = address(domainBinding);
        bool ok;
        uint256 word;
        uint256 len;
        assembly {
            let out := mload(0x40)
            ok := staticcall(gas(), gate, add(input, 0x20), mload(input), out, 0x20)
            len := returndatasize()
            word := mload(out)
        }
        return ok && len >= 32 && word == 1;
    }

    /// @dev `ownerOf` that never reverts: address(0) when the call fails (burned / non-existent token on
    ///      OpenZeppelin-style ERC-721s), returns short data, or returns a non-address word.
    ///      不会回滚的 `ownerOf`：调用失败（OZ 风格 ERC-721 对已销毁 token 回滚）、返回过短或非地址值时返回零地址。
    function _holderOf(address circuits, uint256 tokenId) private view returns (address) {
        (bool ok, bytes memory ret) = circuits.staticcall(abi.encodeCall(IERC721.ownerOf, (tokenId)));
        if (!ok || ret.length < 32) return address(0);
        uint256 word = uint256(bytes32(ret));
        if (word >> 160 != 0) return address(0);
        return address(uint160(word));
    }

    // ---------- Admin / 管理（仅费率与国库）----------

    function setLabelFee(uint256 fee) external onlyOwner {
        emit LabelFeeChanged(labelFee, fee);
        labelFee = fee;
    }

    function setTreasury(address treasury_) external onlyOwner {
        if (treasury_ == address(0)) revert ZeroAddress();
        emit TreasuryChanged(treasury, treasury_);
        treasury = treasury_;
    }

    /// @notice Send accumulated BNB fees to treasury; anyone may call / 将累计 BNB 转入国库，任何人可调
    function withdraw() external {
        uint256 amount = address(this).balance;
        (bool ok,) = treasury.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit Withdrawn(treasury, amount);
    }

    // ---------- Delegation (EIP-712) / 委托校验 ----------

    /// @notice EIP-712 domain separator; rebuilt if chain id changed (fork) / 域分隔符，链 id 变化时重建
    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return block.chainid == _cachedChainId ? _cachedDomainSeparator : _buildDomainSeparator();
    }

    /// @notice Typed digest of Delegation{container, signer, expires} / 委托签名摘要
    function delegationDigest(address container, address signer, uint64 expires) public view returns (bytes32) {
        return keccak256(abi.encodePacked(
            "\x19\x01", DOMAIN_SEPARATOR(),
            keccak256(abi.encode(DELEGATION_TYPEHASH, container, signer, expires))
        ));
    }

    /// @notice True iff sig was produced by current circuit holder over Delegation and not expired.
    ///         当且仅当签名来自当前电路持有人且未过期时返回 true。
    function verifyDelegation(address circuits, uint256 tokenId, address signer, uint64 expires, bytes calldata sig)
        external view returns (bool)
    {
        // SD-02: TAP-20 3.4 requires `expires` to be strictly in the future, and says this function
        // implements exactly that check. `<=` keeps the contract and the SDK from disagreeing by a second.
        // SD-02：TAP-20 3.4 要求 `expires` 严格位于未来，并规定本函数精确实现该判据；用 `<=` 以免
        // 合约与 SDK 相差一秒。
        if (expires <= block.timestamp || signer == address(0)) return false;
        address container = hub.accountOf(circuits, tokenId);
        address recovered = ECDSA.recover(delegationDigest(container, signer, expires), sig);
        if (recovered == address(0)) return false;
        return recovered == _holderOf(circuits, tokenId); // burned token -> address(0) != recovered -> false
    }

    /// @dev The delegation domain is anchored on the DeWebHub, NOT on this contract. A delegation only says
    ///      "the circuit holder authorises this signer"; it needs no directory to be meaningful, and binding it
    ///      here would make an optional contract mandatory -- a service could not be used at all until someone
    ///      deployed a directory. The hub is already deployed, is per-chain (so cross-chain replay is still
    ///      prevented) and is what derives the container in the first place, so it is the right anchor. Every
    ///      directory deployment on a chain therefore shares one delegation domain.
    ///      委托的域锚定在 DeWebHub 而非本合约。委托只表示"电路持有人授权了这个签名者"，本身不需要目录；
    ///      若绑定到本合约，一个可选组件就会变成必需品——没人部署目录前服务根本无法使用。中枢已部署、按链区分
    ///      （跨链重放依然防住），且容器本就由它推导，是正确的锚点。同一条链上所有目录部署共用同一个委托域。
    function _buildDomainSeparator() private view returns (bytes32) {
        return keccak256(abi.encode(_EIP712_DOMAIN_TYPEHASH, _NAME_HASH, _VERSION_HASH, block.chainid, address(hub)));
    }
}
