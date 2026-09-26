// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20, IERC721, IDeWebHub, Ownable, ECDSA} from "./interfaces.sol";
import {
    ZeroAddress, ZeroAmount, NotHolder, ContributionTooHigh, Expired, BadSignature, NothingToSettle,
    InsufficientBalance, NoPendingWithdraw, CooldownActive, WithdrawWindowClosed, AmountTooLarge, BadProvider,
    SessionTooLong, SessionShorteningNotSupported, Reentrancy, TransferFailed
} from "./interfaces.sol";

/// @title TapeAPIEscrow (v2: per-provider channels)
/// @notice Prepaid BEM escrow built from independent (consumer, provider) channels. A consumer funds a channel
///         toward one provider, signs monotonic cumulative vouchers (EIP-712) off-chain, and anyone settles them
///         on-chain out of that channel only. The channel balance IS the cap: there is no separate allowance, no
///         shared pool, and therefore no way for a voucher toward one provider to touch money funded toward another
///         (the v1 C-01 self-dealing drain is structurally inexpressible, see docs/DECISION-escrow-v2.md).
///         Zero protocol fee. Each provider (service container) may opt in to a voluntary `contributionBps`
///         (default 0, hard cap 50%) routed to the standard-maintenance treasury at settlement. The owner can only
///         rotate the treasury address.
///         预付 BEM 托管 v2：每个 (消费者, 提供者) 一条独立通道。消费者向某个提供者充值通道、链下签发单调递增的
///         累计凭证；任何人可上链结算，且只能从该通道支付。通道余额即上限：没有额度、没有共享池，因此对一个
///         提供者的凭证永远碰不到充给另一个提供者的钱（v1 的 C-01 自付自收在结构上无法表达）。
///         零协议费；提供者可自愿设置 `contributionBps`（默认 0，硬上限 50%）；owner 唯一权限是更换金库地址。
///
///         Provider protection is ONE delay: a withdrawal must be requested (`WithdrawRequested` is public) and is
///         executable only after WITHDRAW_COOLDOWN (48h), for WITHDRAW_WINDOW (7d). The provider MUST watch that
///         event and settle inside the cooldown; that is the provider's whole protection, and it is the same
///         guarantee v1's double window (allowance decrease 24h + withdraw 24h) gave, because v1's decrease request
///         was equally a public event the provider had to react to. Nothing a consumer can do shrinks a channel
///         faster than that: `fund` only adds, `authorizeSession` only extends, and there is no revoke.
///         提供者保护只有一个延迟：提现必须先请求（`WithdrawRequested` 公开可见），48h 冷静期后 7 天内可执行。
///         提供者 MUST 监听该事件并在冷静期内结算——这就是提供者的全部保护，且与 v1 的双窗口在实质上相同：
///         v1 的降额请求同样是提供者必须响应的公开事件。消费者没有任何操作能更快地缩小通道。
///
///         Partial settlement is a legitimate flow, not a defence: a provider that keeps serving past the channel
///         balance has chosen to extend credit; `settle` pays min(delta, channel), and the same voucher settles
///         the remainder after the consumer funds again.
///         部分结算是合法流程而非防御：提供者继续服务超过通道余额即是自愿赊账；`settle` 支付 min(delta, 通道)，
///         同一张凭证在消费者补充通道后可续结余额。
contract TapeAPIEscrow is Ownable {
    // ---------- Constants / 常量 ----------
    uint16 public constant MAX_CONTRIBUTION_BPS = 5000;   // 50% hard cap against fat-finger / 防误操作上限
    uint64 public constant WITHDRAW_COOLDOWN = 48 hours;  // the provider's settlement window / 提供者的结算窗口
    uint64 public constant WITHDRAW_WINDOW = 7 days;      // execution window after the cooldown; a request cannot stay armed for weeks / 冷静期后的执行窗口
    uint64 public constant MAX_SESSION = 30 days;         // a session key cannot be authorised further ahead than this / 会话密钥最长授权期

    bytes32 private constant _EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant _NAME_HASH = keccak256("TapeAPIEscrow");
    bytes32 private constant _VERSION_HASH = keccak256("1");
    /// @notice Voucher(address consumer,address provider,uint256 cumulative,uint64 expires) -- unchanged from v1,
    ///         as is the domain (name "TapeAPIEscrow", version "1"), so SDK voucher signing did not change.
    ///         与 v1 完全相同（含域的 name / version），因此 SDK 的凭证签名路径不变。
    bytes32 public constant VOUCHER_TYPEHASH =
        keccak256("Voucher(address consumer,address provider,uint256 cumulative,uint64 expires)");

    uint256 private immutable _cachedChainId;
    bytes32 private immutable _cachedDomainSeparator;

    // ---------- Storage / 存储 ----------
    IERC20 public immutable bem;       // payment token / 支付代币
    IDeWebHub public immutable hub;    // DeWebHub for accountOf / 容器推导
    address public treasury;           // standard-maintenance treasury / 标准维护金库

    struct PendingWithdraw { uint192 amount; uint64 requestedAt; }

    mapping(address consumer => mapping(address provider => uint256)) private _channel;   // funds this provider may settle against / 该提供者可结算的资金
    mapping(address consumer => mapping(address provider => uint256)) private _claimed;   // cumulative already paid, monotone / 已结算累计额，单调不减
    mapping(address consumer => mapping(address provider => mapping(address key => uint64))) private _session; // key expiry, per channel / 会话到期，按通道
    mapping(address consumer => mapping(address provider => PendingWithdraw)) private _pending;
    mapping(address provider => uint16) private _contributionBps;  // provider-set, default 0 / 提供者自设

    uint256 private _lock = 1;       // reentrancy guard / 重入锁

    // ---------- Events / 事件 ----------
    event Funded(address indexed consumer, address indexed provider, uint256 amount);
    /// @dev The provider's cue: settle before `availableAt`, or the consumer may take `amount` from the channel.
    ///      提供者的信号：在 `availableAt` 前结算，否则消费者可从通道取走 `amount`。
    event WithdrawRequested(address indexed consumer, address indexed provider, uint256 amount, uint64 availableAt);
    event Withdrawn(address indexed consumer, address indexed provider, uint256 amount);
    event WithdrawCancelled(address indexed consumer, address indexed provider);
    event SessionAuthorized(address indexed consumer, address indexed provider, address indexed key, uint64 expires);
    event Settled(address indexed consumer, address indexed provider, uint256 paid, uint256 contribution);
    event ContributionSet(address indexed provider, uint16 bps);
    event TreasuryChanged(address indexed oldTreasury, address indexed newTreasury);

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    constructor(address bem_, address hub_, address treasury_) {
        if (bem_ == address(0) || hub_ == address(0) || treasury_ == address(0)) revert ZeroAddress();
        bem = IERC20(bem_);
        hub = IDeWebHub(hub_);
        treasury = treasury_;
        emit TreasuryChanged(address(0), treasury_);
        _cachedChainId = block.chainid;
        _cachedDomainSeparator = _buildDomainSeparator();
    }

    // ---------- Consumer actions / 消费者操作 ----------

    /// @notice Fund the channel toward `provider` (requires prior ERC-20 approve). Immediate; the channel balance is
    ///         the most this provider can ever settle. `provider` may be neither the zero address nor this contract
    ///         (money funded there could never be settled or withdrawn to anyone but the consumer).
    ///         为通向 `provider` 的通道充值（需先 approve）。立即生效；通道余额即该提供者可结算的上限。
    ///         `provider` 不得为零地址或本合约。
    function fund(address provider, uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        _checkProvider(provider);
        _channel[msg.sender][provider] += amount;
        _safeTransferFrom(msg.sender, address(this), amount);
        emit Funded(msg.sender, provider, amount);
    }

    /// @notice Start the WITHDRAW_COOLDOWN for taking `amount` out of the channel toward `provider`. Replaces any
    ///         earlier request on that channel and restarts its clock. `WithdrawRequested` is the provider's cue to
    ///         settle: everything it has served but not settled by `availableAt` is at risk after that point.
    ///         为从通向 `provider` 的通道取出 `amount` 启动冷静期。覆盖该通道上的旧请求并重新计时。
    ///         `WithdrawRequested` 即提供者的结算信号：在 `availableAt` 前未结算的服务此后有风险。
    function requestWithdraw(address provider, uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        if (amount > _channel[msg.sender][provider]) revert InsufficientBalance();
        if (amount > type(uint192).max) revert AmountTooLarge();
        _pending[msg.sender][provider] = PendingWithdraw(uint192(amount), uint64(block.timestamp));
        emit WithdrawRequested(msg.sender, provider, amount, uint64(block.timestamp) + WITHDRAW_COOLDOWN);
    }

    /// @notice Withdraw the pending request on the channel toward `provider`. Without this a consumer who armed a
    ///         withdrawal and changed its mind could only replace it with a 1-wei request, leaving a stale
    ///         `WithdrawRequested` signal for the provider. Cancelling can only help the provider (its window
    ///         pressure disappears), so it needs no delay.
    ///         撤回本人对该通道的待处理提现请求。若无此函数，改变主意的消费者只能用 1 wei 的请求去覆盖，
    ///         给提供者留下一个过时的 `WithdrawRequested` 信号。撤回只会对提供者有利（窗口压力消失），故无需延迟。
    function cancelWithdraw(address provider) external {
        if (_pending[msg.sender][provider].requestedAt == 0) revert NoPendingWithdraw();
        delete _pending[msg.sender][provider];
        emit WithdrawCancelled(msg.sender, provider);
    }

    /// @notice Execute the pending request on the channel toward `provider`. Only inside
    ///         [requestedAt + WITHDRAW_COOLDOWN, requestedAt + WITHDRAW_COOLDOWN + WITHDRAW_WINDOW]; before that it
    ///         reverts CooldownActive, after that WithdrawWindowClosed and the request must be re-made. Pays
    ///         min(requested, current channel) -- settlements during the cooldown come first -- and clears the request.
    ///
    ///         Rationale: the cooldown is the provider's whole protection. The provider MUST settle within it; a
    ///         provider that does not is not paid for what it served against this channel, exactly as a v1 provider
    ///         that ignored `AllowanceDecreaseRequested` for 24h was not paid. Both designs reduce to "a public event
    ///         plus a fixed window in which the provider must act"; v2 has one such event instead of two.
    ///         执行通向 `provider` 的通道上的提现请求。仅在 [请求 + 48h, 请求 + 48h + 7d] 内可执行；支付
    ///         min(所请求, 当前通道余额)——冷静期内的结算优先——并清除请求。
    ///         理由：冷静期就是提供者的全部保护。提供者 MUST 在冷静期内结算；不结算的提供者拿不到它对该通道
    ///         已提供服务的报酬，正如 v1 中忽略 `AllowanceDecreaseRequested` 24 小时的提供者同样拿不到。两种设计
    ///         都归结为"一个公开事件 + 一个提供者必须行动的固定窗口"；v2 只有一个事件而不是两个。
    function withdraw(address provider) external nonReentrant {
        PendingWithdraw memory p = _pending[msg.sender][provider];
        if (p.amount == 0) revert NoPendingWithdraw();
        uint64 availableAt = p.requestedAt + WITHDRAW_COOLDOWN;
        if (block.timestamp < availableAt) revert CooldownActive(availableAt);
        if (block.timestamp > availableAt + WITHDRAW_WINDOW) revert WithdrawWindowClosed();
        uint256 bal = _channel[msg.sender][provider];
        uint256 amount = p.amount > bal ? bal : p.amount;
        delete _pending[msg.sender][provider];
        if (amount == 0) revert InsufficientBalance();   // settled away during the cooldown / 冷静期内已被结算清空
        _channel[msg.sender][provider] = bal - amount;
        _safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, provider, amount);
    }

    /// @notice Authorize `key` to sign vouchers on the channel toward `provider` until `expires`, where
    ///         now < expires <= now + MAX_SESSION. Extend-only: a value below the current expiry reverts. There is
    ///         no revoke and shortening is not supported -- a leaked key is bounded by ONE channel's balance and by
    ///         MAX_SESSION, and simply expires. A consumer who wants a tighter bound authorises a shorter key or a
    ///         smaller channel; both are visible on-chain to the provider before it serves.
    ///         授权 `key` 在通向 `provider` 的通道上签发凭证至 `expires`（now < expires <= now + MAX_SESSION）。
    ///         只可延长；无撤销，也不支持缩短——泄露的密钥损失以一条通道的余额与 MAX_SESSION 为界，自然过期。
    ///         想要更紧的边界就授权更短的密钥或更小的通道，两者提供者在服务前都能在链上看到。
    function authorizeSession(address provider, address key, uint64 expires) external {
        if (key == address(0)) revert ZeroAddress();
        _checkProvider(provider);
        if (expires <= block.timestamp) revert Expired();
        uint64 max = uint64(block.timestamp) + MAX_SESSION;
        if (expires > max) revert SessionTooLong(max);
        if (expires < _session[msg.sender][provider][key]) revert SessionShorteningNotSupported();
        _session[msg.sender][provider][key] = expires;
        emit SessionAuthorized(msg.sender, provider, key, expires);
    }

    // ---------- Provider actions / 提供者操作 ----------

    /// @notice Set the voluntary contribution for the service identified by (circuits, tokenId).
    ///         Caller must be the current circuit holder; provider = hub.accountOf(circuits, tokenId).
    ///         `bps` is in basis points, 0 disables, hard cap MAX_CONTRIBUTION_BPS.
    ///         为电路 (circuits, tokenId) 对应的服务设置自愿贡献比例。调用者必须是当前电路持有人；
    ///         provider = hub.accountOf(circuits, tokenId)。万分比，0 为关闭，硬上限 MAX_CONTRIBUTION_BPS。
    function setContribution(address circuits, uint256 tokenId, uint16 bps) external {
        if (IERC721(circuits).ownerOf(tokenId) != msg.sender) revert NotHolder();
        if (bps > MAX_CONTRIBUTION_BPS) revert ContributionTooHigh(bps);
        address provider = hub.accountOf(circuits, tokenId);
        if (provider == address(0)) revert ZeroAddress();
        _contributionBps[provider] = bps;
        emit ContributionSet(provider, bps);
    }

    // ---------- Settlement / 结算 ----------

    /// @notice Settle a voucher out of the (consumer, provider) channel; callable by anyone. Valid while
    ///         `block.timestamp <= expires`. The signer MUST be `consumer`, or a key whose session ON THIS CHANNEL is
    ///         live at settlement (`sessionExpiry(consumer, provider, signer) >= block.timestamp`); it does not have to
    ///         outlive the voucher. `provider` may be neither the zero address nor this contract (M-01). Pays
    ///         `pay = min(cumulative - claimed, channel)`: `pay - contribution` to provider and
    ///         `contribution = pay * contributionBps[provider] / 10000` to treasury (skipped when 0); `claimed += pay`.
    ///         `pay < delta` is partial settlement, a supported credit flow: the provider served beyond the channel,
    ///         and the same voucher settles the rest once the consumer funds again.
    ///         从 (consumer, provider) 通道结算凭证，任何人可调；`block.timestamp <= expires` 期间有效。签名者 MUST
    ///         为 consumer 本人，或在**该通道**上、**结算时**仍有效的会话密钥；无需覆盖凭证整个生命周期。
    ///         `provider` 不得为零地址或本合约。支付 `pay = min(delta, 通道余额)`；`pay < delta` 即部分结算，
    ///         是受支持的赊账流程：同一张凭证在消费者补充通道后可续结余额。
    function settle(address consumer, address provider, uint256 cumulative, uint64 expires, bytes calldata sig)
        external nonReentrant
    {
        if (block.timestamp > expires) revert Expired();
        _checkProvider(provider);
        address signer = ECDSA.recover(voucherDigest(consumer, provider, cumulative, expires), sig);
        if (signer == address(0)) revert BadSignature();
        // H-01 rule kept from v1: the session must be live NOW, not until the voucher's own expiry.
        // 沿用 v1 的 H-01 规则：会话须在"此刻"有效，而非覆盖凭证自身的到期。
        if (signer != consumer && _session[consumer][provider][signer] < block.timestamp) revert BadSignature();

        uint256 already = _claimed[consumer][provider];
        if (cumulative <= already) revert NothingToSettle();
        uint256 delta = cumulative - already;
        uint256 bal = _channel[consumer][provider];
        uint256 pay = delta > bal ? bal : delta;   // partial settlement / 部分结算
        if (pay == 0) revert InsufficientBalance();

        uint256 contribution = (pay * _contributionBps[provider]) / 10_000;
        // effects / 先改状态
        _claimed[consumer][provider] = already + pay;
        _channel[consumer][provider] = bal - pay;
        // interactions / 后转账
        _safeTransfer(provider, pay - contribution);
        if (contribution > 0) _safeTransfer(treasury, contribution);
        emit Settled(consumer, provider, pay, contribution);
    }

    // ---------- Views / 查询 ----------

    /// @notice Funds in the channel toward `provider`: the most it can still settle / 通道余额，即该提供者还可结算的上限
    function channelOf(address consumer, address provider) external view returns (uint256) { return _channel[consumer][provider]; }
    function claimedOf(address consumer, address provider) external view returns (uint256) { return _claimed[consumer][provider]; }
    /// @notice Expiry of `key` on the channel toward `provider`; 0 when never authorised / 该通道上密钥的到期时间
    function sessionExpiry(address consumer, address provider, address key) external view returns (uint64) {
        return _session[consumer][provider][key];
    }
    /// @notice Pending withdraw request on the channel (amount, requestedAt); amount == 0 when none / 该通道的待处理提现请求
    function pendingWithdraw(address consumer, address provider) external view returns (uint256 amount, uint64 requestedAt) {
        PendingWithdraw memory p = _pending[consumer][provider];
        return (p.amount, p.requestedAt);
    }
    /// @notice Contribution in basis points a provider has opted in to (0 = none) / 提供者自设的贡献比例（万分比）
    function contributionOf(address provider) external view returns (uint16) { return _contributionBps[provider]; }

    /// @notice EIP-712 domain separator; rebuilt if chain id changed (fork) / 域分隔符
    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return block.chainid == _cachedChainId ? _cachedDomainSeparator : _buildDomainSeparator();
    }

    /// @notice Typed digest of Voucher{consumer, provider, cumulative, expires} / 凭证签名摘要
    function voucherDigest(address consumer, address provider, uint256 cumulative, uint64 expires)
        public view returns (bytes32)
    {
        return keccak256(abi.encodePacked(
            "\x19\x01", DOMAIN_SEPARATOR(),
            keccak256(abi.encode(VOUCHER_TYPEHASH, consumer, provider, cumulative, expires))
        ));
    }

    // ---------- Admin / 管理（仅金库地址）----------

    /// @notice Rotate the treasury address. This is the owner's only power: it cannot change any
    ///         provider's bps, pause, or touch any channel.
    ///         更换金库地址。这是 owner 唯一的权限：不能改任何 provider 的 bps、不能暂停、不能动任何通道。
    function setTreasury(address treasury_) external onlyOwner {
        if (treasury_ == address(0)) revert ZeroAddress();
        emit TreasuryChanged(treasury, treasury_);
        treasury = treasury_;
    }

    // ---------- Internal / 内部 ----------

    /// @dev M-01: paying the escrow itself or the zero address burns funds and breaks `bem.balanceOf(this) ==
    ///      Σ channel`; refusing them at `fund` / `authorizeSession` as well means no channel can ever exist there.
    ///      M-01：付给托管自身或零地址会烧毁资金并破坏偿付恒等式；在 fund / authorizeSession 处一并拒绝，
    ///      使这类通道根本不可能存在。
    function _checkProvider(address provider) private view {
        if (provider == address(0) || provider == address(this)) revert BadProvider();
    }

    // SafeERC20 风格转账 / SafeERC20-style transfers

    /// @dev Works with tokens returning bool or nothing / 兼容返回 bool 或无返回值的代币
    function _safeTransfer(address to, uint256 amount) private {
        _callToken(abi.encodeCall(IERC20.transfer, (to, amount)));
    }

    function _safeTransferFrom(address from, address to, uint256 amount) private {
        _callToken(abi.encodeCall(IERC20.transferFrom, (from, to, amount)));
    }

    function _callToken(bytes memory data) private {
        (bool ok, bytes memory ret) = address(bem).call(data);
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool))) || (ret.length == 0 && address(bem).code.length == 0)) {
            revert TransferFailed();
        }
    }

    function _buildDomainSeparator() private view returns (bytes32) {
        return keccak256(abi.encode(_EIP712_DOMAIN_TYPEHASH, _NAME_HASH, _VERSION_HASH, block.chainid, address(this)));
    }
}
