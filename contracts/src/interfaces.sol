// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title TapeAPI shared interfaces, structs, errors and a minimal Ownable
/// @notice 共享的最小接口 / 结构体 / 错误 / 极简 Ownable（不依赖 OpenZeppelin）

// ---------- External interfaces / 外部合约最小接口 ----------

/// @dev Minimal ERC-20 (BEM) / 最小 ERC-20 接口
interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @dev Minimal ERC-721 (Circuits) / 最小 ERC-721 接口
interface IERC721 {
    function ownerOf(uint256 tokenId) external view returns (address);
}

/// @dev DeWebHub: ERC-6551 container derivation / 容器地址推导
interface IDeWebHub {
    function accountOf(address circuits, uint256 tokenId) external view returns (address container);
}

/// @dev Circuits factory: `isCPU(addr)` is true iff `addr` is a circuits (processor) contract deployed by the
///      protocol factory. Used by ServiceDirectory to reject home-made ERC-721s (D-01).
///      电路工厂：`isCPU(addr)` 为真当且仅当该地址是协议工厂部署的电路合约。目录用它拒绝自制 ERC-721。
interface IFactory {
    function isCPU(address circuits) external view returns (bool);
}

/// @dev DomainBinding: container activation status. Older implementations revert instead of
///      returning false, so callers MUST treat a revert as "not live".
///      容器激活状态；旧实现可能 revert 而非返回 false，调用方 MUST 把 revert 视为未激活。
interface IDomainBinding {
    function isContainerLive(address container) external view returns (bool);
}

// ---------- Shared structs / 共享结构体 ----------

/// @dev One registered service (a circuit) / 一个已登记的服务（电路）
struct Service {
    address circuits;     // ERC-721 contract / 电路合约
    uint256 tokenId;      // token id / 电路编号
    address container;    // hub.accountOf(circuits, tokenId) / 容器地址
    bytes32 label;        // 0 = no label / 0 表示无标签
    string manifestPath;  // DeWEB path of tapeapi.json / 清单路径
    uint64 updatedAt;     // last write timestamp / 最近更新时间
}

// ---------- Shared errors / 共享自定义错误 ----------

error NotOwner();                 // Ownable: caller is not owner / 非合约 owner
error NotPendingOwner();          // acceptOwnership: caller is not pendingOwner / 非待接受的新 owner
error ZeroAddress();              // zero address argument / 零地址参数
error NotHolder();                // msg.sender != circuits.ownerOf(tokenId) (or token does not exist) / 非电路持有人
error NotCPU();                   // circuits is not a factory-deployed circuits contract / 非工厂部署的电路合约
error ServiceNotFound();          // container has no service / 容器未登记
error LabelTaken(bytes32 label);  // label held by another container / 标签已被占用
error LabelNotFound(bytes32 label);
error InsufficientFee(uint256 required, uint256 provided);
error IndexOutOfBounds();
error TransferFailed();           // native or token transfer failed / 转账失败
error ContributionTooHigh(uint16 bps); // > MAX_CONTRIBUTION_BPS / 贡献比例超上限
error NotLive();                  // container not activated (DomainBinding) / 容器未激活
error Expired();                  // voucher: block.timestamp > expires; authorizeSession: expires <= now / 已过期
error BadSignature();             // recover failed, or signer is neither consumer nor a session key live for this channel / 签名无效或会话未在此通道生效
error NothingToSettle();          // cumulative <= claimed / 无新增应付
error InsufficientBalance();      // settle: channel is 0; requestWithdraw: amount > channel; withdraw: channel drained / 通道余额不足
error NoPendingWithdraw();        // withdraw(provider) without a request on that channel / 该通道无提现请求
error CooldownActive(uint64 availableAt); // withdraw before requestedAt + WITHDRAW_COOLDOWN / 冷静期未过
error WithdrawWindowClosed();     // withdraw after requestedAt + cooldown + window; re-request / 提现窗口已关闭，需重新请求
error AmountTooLarge();           // requestWithdraw amount > type(uint192).max / 提现金额超出字段宽度
error BadProvider();              // provider is the zero address or the escrow itself (fund / authorizeSession / settle) / 提供者地址非法
error SessionTooLong(uint64 max); // authorizeSession beyond now + MAX_SESSION / 会话超过最长期限
error SessionShorteningNotSupported(); // authorizeSession below the current expiry: there is no revoke, keys simply expire / 不支持缩短会话，密钥只会自然过期
error Reentrancy();
error ZeroAmount();

// ---------- Minimal Ownable (two-step) / 极简两步 Ownable ----------

/// @dev Two-step ownership (E-07): `transferOwnership` only nominates `pendingOwner`; the nominee must call
///      `acceptOwnership`. Used only for label fee / treasury addresses; never for user funds or rates.
///      两步转移：`transferOwnership` 仅提名 `pendingOwner`，被提名者需调用 `acceptOwnership`。
///      仅用于标签费与国库地址，不涉及用户资金或任何费率。
abstract contract Ownable {
    address public owner;
    address public pendingOwner;

    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor() {
        owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);
    }

    /// @notice Nominate a new owner (non-zero). Calling again replaces the nominee; nominating yourself cancels.
    ///         提名新 owner（非零）。再次调用覆盖提名；提名自己即取消。
    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    /// @notice Nominee accepts ownership / 被提名者接受所有权
    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotPendingOwner();
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        delete pendingOwner;
    }
}

// ---------- Signature helper / 签名恢复工具 ----------

/// @dev ecrecover wrapper accepting v in {0,1,27,28}; returns address(0) on failure
///      支持 v 为 0/1/27/28 的 ecrecover 封装；失败返回零地址
library ECDSA {
    function recover(bytes32 digest, bytes memory sig) internal pure returns (address) {
        if (sig.length != 65) return address(0);
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly ("memory-safe") {
            r := mload(add(sig, 0x20))
            s := mload(add(sig, 0x40))
            v := byte(0, mload(add(sig, 0x60)))
        }
        if (v < 27) v += 27;
        if (v != 27 && v != 28) return address(0);
        // reject high-s to avoid malleability / 拒绝高 s 值防止可延展性
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) return address(0);
        return ecrecover(digest, v, r, s);
    }
}
