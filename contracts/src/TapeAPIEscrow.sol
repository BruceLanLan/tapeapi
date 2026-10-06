// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20, IERC721, IDeWebHub, Ownable, ECDSA} from "./interfaces.sol";
import {
    ZeroAddress, ZeroAmount, NotHolder, ContributionTooHigh, Expired, BadSignature, NothingToSettle,
    InsufficientBalance, NoPendingWithdraw, CooldownActive, WithdrawWindowClosed, AmountTooLarge, BadProvider,
    SessionTooLong, SessionShorteningNotSupported, Reentrancy, TransferFailed, BadTreasury
} from "./interfaces.sol";

/// @title TapeAPIEscrow (v3: per-provider channels, one immutable token per instance)
/// @notice Prepaid single-token escrow built from independent (consumer, provider) channels. The token is an
///         immutable constructor argument (one instance per token, same bytecode; which tokens are admitted:
///         TAPI-22 §3.5). The contract never reads the token's decimals: every amount (fund, channel, voucher
///         `cumulative`, withdrawal, contribution) is in the token's own base units. A consumer funds a channel
///         toward one provider, signs monotonic cumulative vouchers (EIP-712) off-chain, and anyone settles them
///         on-chain out of that channel only. The channel balance IS the cap: there is no separate allowance, no
///         shared pool, and therefore no way for a voucher toward one provider to touch money funded toward another
///         (the v1 C-01 self-dealing drain is structurally inexpressible, see docs/DECISION-escrow-v2.md).
///         Zero protocol fee. Each provider (service container) carries a maintenance contribution, carved out of
///         its own share at settlement and ACCRUED to the standard-maintenance treasury (`treasuryAccrued`), which
///         anyone can pay out to the current `treasury` with `claimTreasury()` (pull, v3): `settle` never transfers
///         to the treasury, so a treasury that cannot receive the token never blocks a provider's settlement.
///         DEFAULT_CONTRIBUTION_BPS (1%) until the circuit holder sets a value, then that value (0 included), hard
///         cap MAX_CONTRIBUTION_BPS (20%). Both are constants. The owner can only rotate the treasury address and
///         nominate a successor. The treasury role includes what is accrued but not yet claimed: a rotation first pays
///         it to the OUTGOING treasury, and only if that payment fails does it stay accrued for the new one.
///         Solvency: `token.balanceOf(this) >= Σ channelOf + treasuryAccrued`; `>=`, not `==`, because anyone can
///         transfer tokens to this address directly, and such a donation stays here (no sweep, by design). The
///         contract never reads its own balance, so a donation cannot make any path revert.
///         预付单币种托管 v3：代币是不可变的构造参数（每种代币一个实例，同一份字节码；准入标准见 TAPI-22 §3.5）。
///         合约从不读取代币的小数位：所有金额都以该代币的最小单位计。
///         每个 (消费者, 提供者) 一条独立通道。消费者向某个提供者充值通道、链下签发单调递增的
///         累计凭证；任何人可上链结算，且只能从该通道支付。通道余额即上限：没有额度、没有共享池，因此对一个
///         提供者的凭证永远碰不到充给另一个提供者的钱（v1 的 C-01 自付自收在结构上无法表达）。
///         零协议费；维护贡献在结算时从提供者自己的份额中划出、记入金库应收额 `treasuryAccrued`，任何人可调用
///         `claimTreasury()` 把它付给当前金库（v3 拉取式）：`settle` 从不向金库转账，收不了该代币的金库永远不会阻塞
///         提供者的结算。电路持有人设定之前为 DEFAULT_CONTRIBUTION_BPS（1%），设定之后为所设之值（含 0），硬上限
///         MAX_CONTRIBUTION_BPS（20%），两者均为常量；owner 唯一权限是更换金库地址与提名继任者。"金库"角色包括已记账未领取
///         的应收额：换金库时先把它付给**旧**金库，只有这笔付款失败时才留作应收、归新金库。
///         偿付：`token.balanceOf(this) >= Σ channelOf + treasuryAccrued`；用 `>=` 而非 `==`，因为任何人都可以直接
///         向本地址转入代币，这种捐赠留在原处（按设计没有清扫）。合约从不读取自身余额，所以捐赠不会让任何路径回滚。
///
///         Provider protection is ONE delay: a withdrawal must be requested (`WithdrawRequested` is public) and is
///         executable only after WITHDRAW_COOLDOWN (48h), for WITHDRAW_WINDOW (7d). The provider MUST watch that
///         event and settle inside the cooldown, and it is the same guarantee v1's double window (allowance
///         decrease 24h + withdraw 24h) gave, because v1's decrease request was equally a public event the provider
///         had to react to. `fund` only adds, `authorizeSession` only extends, and there is no revoke.
///         The cooldown is measured from the REQUEST, not per channel (A2-03): `fund` does not restart it, so funds
///         added while a request is alive are withdrawable, up to the requested amount, the moment it matures. A
///         provider MUST therefore both settle everything owed before `availableAt` AND not serve against a live
///         request beyond `channelOf - pendingWithdraw.amount` (TAPI-22 §3.2(4)); either half alone is not enough.
///         提供者保护只有一个延迟：提现必须先请求（`WithdrawRequested` 公开可见），48h 冷静期后 7 天内可执行。
///         提供者 MUST 监听该事件并在冷静期内结算，这与 v1 的双窗口在实质上相同：v1 的降额请求同样是提供者必须
///         响应的公开事件。冷静期按"请求"计而非按通道计（A2-03）：`fund` 不重置它，请求存活期间充入的资金在请求
///         到期时即可在所请求数额内被提走。所以提供者 MUST 既在 `availableAt` 前结算全部应收，又不在存活请求之上
///         超出 `channelOf - pendingWithdraw.amount` 提供服务（TAPI-22 §3.2(4)），两者缺一不可。
///
///         Partial settlement is a legitimate flow, not a defence: a provider that keeps serving past the channel
///         balance has chosen to extend credit; `settle` pays min(delta, channel), and the same voucher settles
///         the remainder after the consumer funds again.
///         部分结算是合法流程而非防御：提供者继续服务超过通道余额即是自愿赊账；`settle` 支付 min(delta, 通道)，
///         同一张凭证在消费者补充通道后可续结余额。
contract TapeAPIEscrow is Ownable {
    // ---------- Constants / 常量 ----------
    uint16 public constant DEFAULT_CONTRIBUTION_BPS = 100; // 1% until the holder sets a value (TAPI-22 §3.4) / 持有人设定前的默认值
    uint16 public constant MAX_CONTRIBUTION_BPS = 2000;   // 20% hard cap / 硬上限
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
    IERC20 public immutable token;     // the one token this instance escrows (TAPI-22 §3.5) / 本实例托管的唯一代币
    IDeWebHub public immutable hub;    // DeWebHub for accountOf / 容器推导
    address public treasury;           // standard-maintenance treasury / 标准维护金库
    /// @notice Contributions settled but not yet paid out; owed to whoever `treasury` is when `claimTreasury` runs.
    ///         已结算、尚未付出的贡献；付给 `claimTreasury` 执行时的 `treasury`。
    uint256 public treasuryAccrued;

    struct PendingWithdraw { uint192 amount; uint64 requestedAt; }

    mapping(address consumer => mapping(address provider => uint256)) private _channel;   // funds this provider may settle against / 该提供者可结算的资金
    mapping(address consumer => mapping(address provider => uint256)) private _claimed;   // cumulative already paid, monotone / 已结算累计额，单调不减
    mapping(address consumer => mapping(address provider => mapping(address key => uint64))) private _session; // key expiry, per channel / 会话到期，按通道
    mapping(address consumer => mapping(address provider => PendingWithdraw)) private _pending;
    /// @dev `isSet` is what tells "never set" (DEFAULT_CONTRIBUTION_BPS applies) apart from "set to 0" (no
    ///      contribution); a bare uint16 cannot, because its zero value is both. One slot per provider. Read ONLY
    ///      through `_contributionOf`.
    ///      `isSet` 区分"从未设定"（适用默认值）与"设为 0"（不贡献）；单个 uint16 做不到，因为它的零值同时表示两者。
    ///      每个提供者一个存储槽；只能经 `_contributionOf` 读取。
    struct Contribution { uint16 bps; bool isSet; }
    mapping(address provider => Contribution) private _contribution;

    uint256 private _lock = 1;       // reentrancy guard / 重入锁

    // ---------- Events / 事件 ----------
    event Funded(address indexed consumer, address indexed provider, uint256 amount);
    /// @dev The provider's cue: settle before `availableAt`, or the consumer may take `amount` from the channel.
    ///      提供者的信号：在 `availableAt` 前结算，否则消费者可从通道取走 `amount`。
    event WithdrawRequested(address indexed consumer, address indexed provider, uint256 amount, uint64 availableAt);
    event Withdrawn(address indexed consumer, address indexed provider, uint256 amount);
    event WithdrawCancelled(address indexed consumer, address indexed provider);
    event SessionAuthorized(address indexed consumer, address indexed provider, address indexed key, uint64 expires);
    /// @dev `bps` is the rate this settlement applied, so `contribution == paid * bps / 10000` is checkable from the
    ///      log alone. / `bps` 为本次结算实际适用的比例，仅凭日志即可核验 `contribution == paid * bps / 10000`。
    event Settled(address indexed consumer, address indexed provider, uint256 paid, uint256 contribution, uint16 bps);
    event ContributionSet(address indexed provider, uint16 bps);
    event TreasuryChanged(address indexed oldTreasury, address indexed newTreasury);
    /// @dev Σ Settled.contribution == treasuryAccrued + Σ TreasuryClaimed.amount, checkable from logs alone.
    ///      仅凭日志即可核验：Σ Settled.contribution == treasuryAccrued + Σ TreasuryClaimed.amount。
    event TreasuryClaimed(address indexed treasury, uint256 amount);

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    /// @param token_ the one ERC-20 this instance escrows; immutable. Admission (TAPI-22 §3.5: not upgradeable, no
    ///        freeze / pause / blacklist, no fee or rebase or hook, 8 <= decimals <= 18) is checked off-chain before
    ///        deployment (script/Deploy.s.sol pre-flight); the contract itself assumes nothing about decimals.
    ///        本实例托管的唯一 ERC-20，不可变。准入（TAPI-22 §3.5）在部署前链下核查，合约本身不假设小数位。
    constructor(address token_, address hub_, address treasury_) {
        if (token_ == address(0) || hub_ == address(0) || treasury_ == address(0)) revert ZeroAddress();
        if (treasury_ == token_ || treasury_ == address(this)) revert BadTreasury();   // same rule as setTreasury
        token = IERC20(token_);
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

    /// @notice Set the contribution for the service identified by (circuits, tokenId).
    ///         Caller must be the current circuit holder; provider = hub.accountOf(circuits, tokenId).
    ///         `bps` is in basis points, 0 disables, hard cap MAX_CONTRIBUTION_BPS. Once set, the value (0 included)
    ///         replaces DEFAULT_CONTRIBUTION_BPS for good. It takes effect at the next `settle` and is never
    ///         retroactive: past settlements are final, and a voucher not yet settled is split at the rate in force
    ///         when it settles. `ContributionSet` carries the new effective rate.
    ///         为电路 (circuits, tokenId) 对应的服务设置贡献比例。调用者必须是当前电路持有人；
    ///         provider = hub.accountOf(circuits, tokenId)。万分比，0 为关闭，硬上限 MAX_CONTRIBUTION_BPS。设定之后
    ///         （含 0）永久取代默认值；自下一次 `settle` 起生效，绝不追溯：已结算的不重算，尚未结算的凭证按结算时
    ///         的比例拆分。`ContributionSet` 携带新的有效比例。
    function setContribution(address circuits, uint256 tokenId, uint16 bps) external {
        if (IERC721(circuits).ownerOf(tokenId) != msg.sender) revert NotHolder();
        if (bps > MAX_CONTRIBUTION_BPS) revert ContributionTooHigh(bps);
        address provider = hub.accountOf(circuits, tokenId);
        if (provider == address(0)) revert ZeroAddress();
        _contribution[provider] = Contribution({bps: bps, isSet: true});
        emit ContributionSet(provider, bps);
    }

    // ---------- Settlement / 结算 ----------

    /// @notice Settle a voucher out of the (consumer, provider) channel; callable by anyone. Valid while
    ///         `block.timestamp <= expires`. The signer MUST be `consumer`, or a key whose session ON THIS CHANNEL is
    ///         live at settlement (`sessionExpiry(consumer, provider, signer) >= block.timestamp`); it does not have to
    ///         outlive the voucher. `provider` may be neither the zero address nor this contract (M-01). Pays
    ///         `pay = min(cumulative - claimed, channel)`: `pay - contribution` is transferred to provider and
    ///         `contribution = pay * contributionOf(provider) / 10000` (rounded down, at the rate in force now) is
    ///         added to `treasuryAccrued` -- never transferred here (v3 pull); `claimed += pay`. Because the rate is
    ///         at most 20%, `pay - contribution >= pay * 4 / 5 > 0` whenever `pay > 0`.
    ///         `pay < delta` is partial settlement, a supported credit flow: the provider served beyond the channel,
    ///         and the same voucher settles the rest once the consumer funds again.
    ///         从 (consumer, provider) 通道结算凭证，任何人可调；`block.timestamp <= expires` 期间有效。签名者 MUST
    ///         为 consumer 本人，或在**该通道**上、**结算时**仍有效的会话密钥；无需覆盖凭证整个生命周期。
    ///         `provider` 不得为零地址或本合约。支付 `pay = min(delta, 通道余额)`：`pay - contribution` 转给提供者，
    ///         `contribution`（向下取整，按此刻比例）记入 `treasuryAccrued`，此处不向金库转账（v3 拉取式）；
    ///         `pay < delta` 即部分结算，
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

        uint16 bps = _contributionOf(provider);   // the rate in force at this settlement / 本次结算时有效的比例
        uint256 contribution = (pay * bps) / 10_000;
        // effects / 先改状态
        _claimed[consumer][provider] = already + pay;
        _channel[consumer][provider] = bal - pay;
        if (contribution > 0) treasuryAccrued += contribution;   // pull: the treasury is paid in claimTreasury / 拉取式
        // interaction: the provider's share is the only transfer / 唯一的转账：提供者的份额
        _safeTransfer(provider, pay - contribution);
        emit Settled(consumer, provider, pay, contribution, bps);
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
    /// @notice Effective contribution in basis points: DEFAULT_CONTRIBUTION_BPS until the holder sets a value, then
    ///         that value (0 = none). / 有效贡献比例（万分比）：持有人设定前为默认值，设定后为所设之值（0 为不贡献）
    function contributionOf(address provider) external view returns (uint16) { return _contributionOf(provider); }

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

    // ---------- Treasury / 金库（拉取式）----------

    /// @notice Pay the whole `treasuryAccrued` to the current `treasury`; callable by anyone (the recipient is fixed,
    ///         so the caller chooses only the moment). Reverts `ZeroAmount()` when nothing is accrued. Zeroes the
    ///         accrual before the transfer. If the treasury cannot receive the token (frozen, rejecting contract), or
    ///         the token answers anything but success (see `_tokenCall`), this reverts `TransferFailed()` and changes
    ///         nothing; settlements are unaffected, and the owner can rotate the treasury: the rotation tries the
    ///         outgoing treasury once more and, when that fails too, leaves the accrual claimable to the new address.
    ///         把全部 `treasuryAccrued` 付给当前 `treasury`；任何人可调（收款人固定，调用者只决定时机）。无应收时回滚
    ///         `ZeroAmount()`。先清零再转账。金库收不了该代币（冻结、拒收合约），或代币的回答不是成功（见 `_tokenCall`）
    ///         时回滚 `TransferFailed()` 且不改变任何状态；结算不受影响。owner 可更换金库：更换时再向旧金库付一次，
    ///         仍失败则应收额留给新地址领取。
    function claimTreasury() external nonReentrant returns (uint256 amount) {
        amount = treasuryAccrued;
        if (amount == 0) revert ZeroAmount();
        treasuryAccrued = 0;
        address to = treasury;
        _safeTransfer(to, amount);
        emit TreasuryClaimed(to, amount);
    }

    // ---------- Admin / 管理（仅 owner）----------

    /// @notice Rotate the treasury address. This is the owner's only power: it cannot change any provider's bps,
    ///         pause, or touch any channel. `treasury_` may be neither the zero address (`ZeroAddress()`) nor this
    ///         contract nor the token (`BadTreasury()`): a claim to either would strand the accrual for good.
    ///         Rotating to the current treasury changes nothing and emits nothing.
    ///         Before the address changes, when anything is accrued, the rotation runs `claimTreasury` for the
    ///         OUTGOING treasury (zero, transfer, `TreasuryClaimed(old, amount)`), so the owner cannot redirect what
    ///         the old treasury has already earned. If that claim fails for any reason (the old treasury is frozen or
    ///         rejects, the token answers anything but success), it is rolled back in full -- no token-side effect
    ///         survives -- the rotation still succeeds, and the accrual stays accrued for the NEW treasury: the role
    ///         keeps it, which is what makes a frozen treasury recoverable. A treasury that cannot receive can never
    ///         block its own replacement.
    ///         更换金库地址。这是 owner 唯一的权限：不能改任何 provider 的 bps、不能暂停、不能动任何通道。`treasury_`
    ///         不得为零地址（`ZeroAddress()`）、本合约或代币合约（`BadTreasury()`）：领到这两处的应收额永久卡死。
    ///         换成当前金库什么也不改变、不发事件。改地址之前，若有应收，先为**旧**金库执行一次 `claimTreasury`
    ///         （清零、转账、`TreasuryClaimed(旧, 金额)`），owner 因而无法改走旧金库已挣得的钱。这次领取若因任何原因
    ///         失败（旧金库被冻结或拒收、代币的回答不是成功），会被完整回滚——不留下任何代币侧的效果——更换照样成功，
    ///         应收额留给**新**金库：应收额随角色走，这正是冻结的金库可以恢复的原因。收不了款的金库永远挡不住自己被替换。
    /// @dev The payout is `try this.claimTreasury()`: an external self-call, so a failure reverts that frame alone and
    ///      undoes whatever the token did inside it (a token that moved funds and then answered garbage would
    ///      otherwise be paid twice). `claimTreasury` takes the lock; `setTreasury` only checks it, so during the
    ///      transfer `_lock == 2` and a callback into claimTreasury / settle / fund / withdraw (modifier) or
    ///      setTreasury (the check below) reverts `Reentrancy()`; `treasury` is still the old address then, and the
    ///      lock is back to 1 before `treasury` is written.
    ///      Gas: with limit G, the self-call leaves the outer frame 1/64 of the gas, the inner frame keeps another 1/64
    ///      when it calls the token, and a reverting inner frame hands its unused gas back, so what is left after the
    ///      `catch` is about 2G/64. The rest of this function (one warm SSTORE and one event, about 5k gas) therefore
    ///      completes only from a limit of roughly 170k up, while the claim has run on about G. Measured by the second
    ///      independent review: with a plain token the lowest limit at which the rotation succeeds AND pays is about
    ///      53k; the lowest at which it succeeds WITHOUT paying (a token that burns the claim's gas) is about 168.5k;
    ///      in terms of the token, a transfer costing roughly 130-150k gas or more can be starved (a total of about
    ///      125k cannot, about 145k can). Admitted tokens are far below that (a USDT-pegged token's transfer costs
    ///      about 35-55k), so the owner cannot starve the payout; a token above the threshold is not admissible.
    ///      `testFuzz_R19_rotation_gasLimit_neverSkipsPayout` and `test_R19_rotation_gasSweep_neverSkipsPayout` are
    ///      evidence for tokens whose transfer costs no more than about 130k, and for nothing beyond that.
    ///      付款用 `try this.claimTreasury()`：外部自调用，失败只回滚该调用帧，连同代币在其中做过的一切（否则一个转了账
    ///      却返回乱码的代币会被付两次）。`claimTreasury` 持锁；`setTreasury` 只检查锁，所以转账期间 `_lock == 2`，回调
    ///      claimTreasury / settle / fund / withdraw（修饰器）或 setTreasury（下面的检查）都回滚 `Reentrancy()`。
    ///      gas：设上限为 G，自调用后外帧保留 1/64，内帧调用代币时再保留 1/64，内帧 revert 会把未用的 gas 退回外帧，
    ///      所以 `catch` 之后的余量约为 2G/64。本函数余下部分（一次热 SSTORE 加一个事件，约 5k）因而约需 170k 以上的
    ///      上限才能跑完，而此时领取已跑了约 G。第二轮独立审查实测：普通代币下，更换成功且付清的最低上限约 53k；
    ///      "更换成功却没付"（代币烧光领取的 gas）的最低上限约 168.5k；折算到代币，单次转账成本约 130–150k 或以上才可
    ///      被饿死（总成本约 125k 不可，约 145k 可以）。准入代币远低于此（USDT 锚定币单次转账约 35–55k），owner 因而饿不死
    ///      付款；超过阈值的代币不在准入范围。`testFuzz_R19_rotation_gasLimit_neverSkipsPayout` 与
    ///      `test_R19_rotation_gasSweep_neverSkipsPayout` 只对转账成本不超过约 130k 的代币构成证据，超出此范围不证明任何事。
    function setTreasury(address treasury_) external onlyOwner {
        if (_lock != 1) revert Reentrancy();   // checked, not taken: the payout below takes it / 只检查不持有
        if (treasury_ == address(0)) revert ZeroAddress();
        if (treasury_ == address(this) || treasury_ == address(token)) revert BadTreasury();
        address old = treasury;
        if (treasury_ == old) return;
        if (treasuryAccrued > 0) {
            // pays `old` (still the treasury); any failure is rolled back and ignored / 付给旧金库；失败整体回滚并忽略
            try this.claimTreasury() returns (uint256) {} catch {}
        }
        treasury = treasury_;
        emit TreasuryChanged(old, treasury_);
    }

    // ---------- Internal / 内部 ----------

    /// @dev M-01: paying the escrow itself or the zero address burns funds (or strands them outside every channel);
    ///      refusing them at `fund` / `authorizeSession` as well means no channel can ever exist there.
    ///      M-01：付给托管自身或零地址会烧毁资金并破坏偿付恒等式；在 fund / authorizeSession 处一并拒绝，
    ///      使这类通道根本不可能存在。
    function _checkProvider(address provider) private view {
        if (provider == address(0) || provider == address(this)) revert BadProvider();
    }

    /// @dev The only reader of `_contribution`. / `_contribution` 的唯一读取处。
    function _contributionOf(address provider) private view returns (uint16) {
        Contribution memory c = _contribution[provider];
        return c.isSet ? c.bps : DEFAULT_CONTRIBUTION_BPS;
    }

    // SafeERC20 风格转账 / SafeERC20-style transfers

    /// @dev Works with tokens returning bool or nothing / 兼容返回 bool 或无返回值的代币
    function _safeTransfer(address to, uint256 amount) private {
        _callToken(abi.encodeCall(IERC20.transfer, (to, amount)));
    }

    function _safeTransferFrom(address from, address to, uint256 amount) private {
        _callToken(abi.encodeCall(IERC20.transferFrom, (from, to, amount)));
    }

    /// @dev Every failure of a token call is `TransferFailed()`, never a bare revert or a decode panic.
    ///      代币调用的任何失败都是 `TransferFailed()`，绝不是裸回滚或解码异常。
    function _callToken(bytes memory data) private {
        if (!_tokenCall(data)) revert TransferFailed();
    }

    /// @dev The one place that calls the token and judges the answer. Success iff the call did not revert AND either
    ///      (a) it returned nothing and the token address has code (USDT-style tokens; a codeless address "succeeds"
    ///      at every call and is refused), or (b) it returned at least 32 bytes whose first word is exactly 1 (a
    ///      canonical `true`; extra bytes are ignored). Everything else -- 1 to 31 bytes, a first word of 0 (`false`)
    ///      or of any other value -- is failure, and the caller reverts `TransferFailed()`. A call that reverted is
    ///      failure whatever it returned (even nothing, or a word of 1). The scratch word is zeroed first, so 1 to 31
    ///      returned bytes (left-aligned, low byte 0) can never read as 1; `size >= 32` states the rule explicitly. At most 32 bytes of
    ///      return data are copied, so a callee cannot make the caller run out of gas with a huge payload.
    ///      唯一调用代币并判定结果之处。成功当且仅当调用未回滚，且 (a) 无返回值且代币地址有代码（USDT 式代币；无代码
    ///      地址对任何调用都"成功"，故拒绝），或 (b) 返回至少 32 字节且首字恰为 1（规范的 `true`，多余字节忽略）。
    ///      其它一切——1 到 31 字节、首字为 0（`false`）或任何其它值——都是失败，调用方回滚 `TransferFailed()`。最多复制
    ///      32 字节返回数据，被调方无法用超大返回值让调用方耗尽 gas。
    function _tokenCall(bytes memory data) private returns (bool) {
        address t = address(token);
        bool ok;
        uint256 size;
        uint256 word;
        assembly ("memory-safe") {
            mstore(0x00, 0)   // a short return must not combine with stale scratch into a word of 1 / 短返回值不得与残留内存拼成 1
            ok := call(gas(), t, 0, add(data, 0x20), mload(data), 0x00, 0x20)
            size := returndatasize()
            word := mload(0x00)
        }
        if (!ok) return false;
        if (size == 0) return t.code.length > 0;
        return size >= 32 && word == 1;
    }

    function _buildDomainSeparator() private view returns (bytes32) {
        return keccak256(abi.encode(_EIP712_DOMAIN_TYPEHASH, _NAME_HASH, _VERSION_HASH, block.chainid, address(this)));
    }
}
