# TapeAPI 设计契约 v0.2（所有模块必须遵守）

> v0.2 变更：零协议费 + 提供者自设贡献比例（docs/FEES.md）；目录别名可选激活门槛；SDK `callQuorum` 多提供者一致模式（docs/CROSSCHAIN.md §1）。
> v0.2.1（SDK 审查修复）：信封摘要升级为 `TAPI-1/resp/v2`（覆盖请求与 ok）；全线拒绝高 s 签名；payer 签发/确认分离 + `lastCumulative` 重同步；`dev`/`allowSingleNode`/`allowHttp`/`maxSkewS` 显式开关；原型键拒绝；错误消息不含 URL/密钥。
>
> 2026-09-28：费用模型改为 v0.3（无强制协议费；默认 1% 维护贡献，提供者可设为 0；运营方没有费率开关），由下一版托管实现。下文的 TapeAPIEscrow 描述的是仓库里现有的 v2 合约（贡献默认 0），见 docs/FEES.md 与 TAPI-22 §3.4。

链：BNB Smart Chain, chainId 56。测试：本地 mock RPC。

## 已知外部合约（主网）
- DeWebHub (proxy): 0xe61A9C7213a6Aa616C246a2B569e555B417b25ee
  - accountOf(address circuits, uint256 tokenId) view returns (address container)   // ERC-6551 容器推导
  - endpointOf(address container) view returns (bytes32)
- SiteRegistry (proxy): 0xd006ffdd5Ae313B17729621A00999cD3C71CE5e6
  - fileInfo(address container, string path) view returns (uint256 size, string contentType, bytes32 sha256Hash, uint256 updatedAt, uint256 chunkCount)
  - read(address container, string path) view returns (bytes)
- BEM (ERC-20): 0x5ce033b2bfca3af30b3e8c8457deaf776a8b695a
- Circuits (ERC-721): 工厂部署的处理器合约, ownerOf(tokenId)
- Circuits Factory: 0x68224F668083c29e9800Be2a646d42d18cedF7e2
  - isCPU(address circuits) view returns (bool)   // 目录 register 只接受工厂部署的电路合约
- DomainBinding（可选，用于别名激活门槛）: isContainerLive(address container) view returns (bool)   // 旧实现对未知容器会 revert，视为 false

## 身份
服务 = 一个电路 (circuits, tokenId)。容器 = DeWebHub.accountOf(circuits, tokenId)。
服务清单存于容器的 DeWEB 站点路径 `/.well-known/tapeapi.json`，由 SiteRegistry.read 读取。
开发模式允许 SDK 直接传入 manifest URL 或对象：只有 `createTapeAPI({ dev: true })` 才能 `resolve({ dev })`（否则 `MANIFEST_INVALID('dev resolve disabled')`）。
dev 只放宽 **dev 来源** 的清单（可无委托、可 `http://` 端点）；链上来源的清单在 dev 下照常做全部校验。dev 客户端若配置了 `rpcUrls`，委托签名者仍与 `ownerOf` 比对（`verified.checked: true`）；只有没有 RPC 时才跳过（`checked: false`）。

## 清单 tapeapi.json（TAPI-20）
```json
{
  "tapeapi": "0.1",
  "name": "TapeOut Reader",
  "circuits": "0x...", "tokenId": "4246",
  "container": "0x...",
  "signer": "0x<secp256k1 address>",
  "delegation": { "expires": 1790000000, "sig": "0x..." },
  "endpoints": { "live": ["https://host/tapeapi/v1"], "async": false },
  "methods": [
    { "name": "blockNumber", "priceBEM": "0", "params": {}, "returns": {"blockNumber":"number"} },
    { "name": "circuitHolder", "priceBEM": "0.0001", "params": {"circuits":"address","tokenId":"string"}, "returns": {"holder":"address"} }
  ],
  "payment": { "escrow": "0x...", "unit": "BEM", "decimals": 8 }
}
```
### 委托签名（holder 授权 signer）
EIP-712 domain: { name: "TapeAPI", version: "1", chainId: 56, verifyingContract: 0xe61A9C7213a6Aa616C246a2B569e555B417b25ee (DeWebHub) }
type Delegation { address container; address signer; uint64 expires; }
签名者必须 == circuits.ownerOf(tokenId)（SDK 验证时读链）。

## 响应信封（TAPI-21）
HTTP: POST {live}/{method}，请求体 JSON:
```json
{ "id": "<client uuid>", "method": "circuitHolder", "params": {...}, "voucher": {可选，见下} }
```
响应体 JSON:
```json
{ "id": "...", "ok": true, "result": {...}, "container": "0x..", "ts": 1758300000, "block": 62000000,
  "sig": "0x..." }
```
错误：`{ "id": "...", "ok": false, "error": { "code": "PAYMENT_REQUIRED"|"BAD_VOUCHER"|"METHOD_NOT_FOUND"|"BAD_REQUEST"|"INTERNAL", "message": "...", "data"?: {...} }, "container": "...", "ts":..., "sig": "0x..." }`
签名内容（secp256k1, EIP-191 personal_sign over 32 字节 digest，TAPI-21 v2）：
digest = keccak256( "TAPI-1/resp/v2" ‖ container(20B) ‖ keccak256(id utf8) ‖ keccak256(canonicalJSON({method, params})) ‖ uint8(ok ? 1 : 0) ‖ keccak256(canonicalJSON(ok ? result : error)) ‖ uint64BE(ts) )
canonicalJSON = JSON.stringify，对象键按字典序递归排序，无空白；含自有键 `__proto__`/`constructor`/`prototype` 的对象没有规范形式（CANON_INVALID），请求/响应的 JSON 解析也拒绝这些键。
客户端用**自己发出的** method/params 与**自己解析出的** container 重算摘要；`ok` 在签名内，签名的错误不能改标为成功。`|now − ts| ≤ maxSkewS`（默认 300）。
签名 MUST 低 s、v ∈ {27,28}；`recoverAddress` 与合约 `ECDSA.recover` 一致地拒绝高 s（信封、委托、凭证都走同一函数）。
`INTERNAL` 对外一律 `"internal error"`（细节进 provider 日志）；`BAD_VOUCHER` 因累计值过期时带 `data: { lastCumulative: "<decimal>" }`（= max(本地记录, claimedOf)），SDK 据此重同步并重试一次。

## 支付凭证（TAPI-22）
EIP-712 domain: { name: "TapeAPIEscrow", version: "1", chainId, verifyingContract: <Escrow 地址> }
type Voucher { address consumer; address provider; uint256 cumulative; uint64 expires; }
- provider = 服务容器地址（收款直接进容器）。
- cumulative 单调递增（消费者对该 provider 的累计应付，单位 wei of BEM）。
- 签名者可以是 consumer 本人，或 consumer 授权的 session key，且 sessionExpiry[consumer][key] ≥ block.timestamp（会话只需在**结算时**有效，不必覆盖凭证整个生命周期；H-01）。
- 凭证在 block.timestamp ≤ expires 期间有效（等于时仍有效）。
请求中的 voucher 字段：`{ "consumer":"0x..","provider":"0x..","cumulative":"123","expires":1758400000,"sig":"0x..","signer":"0x.."}`
提供者校验：sig 有效（低 s）；now ≤ expires；session key 签名时 sessionExpiry > now（与合约 settle 一致，不要求覆盖 expires）；last = max(本地 lastCumulative, 链上 claimedOf)，cumulative ≥ last + price 且 cumulative > claimedOf（否则 BAD_VOUCHER + data.lastCumulative）；
available = channelOf(consumer, provider) − pendingWithdraw.amount（提现请求的生命周期为 48 小时冷静期 + 7 天窗口，即 now ≤ requestedAt + 48h + 7d），cumulative − claimedOf ≤ available。托管 v2 按 (消费者, 提供者) 通道计，没有额度概念：消费者先 approve 代币、再 fund 该通道，通道余额就是上限。

## 合约接口
### ServiceDirectory.sol（不可升级，Ownable 仅管标签费与国库，两步转移）
constructor(address hub, address factory, address domainBinding)   // hub、factory 非零；domainBinding == 0 表示不启用激活门槛
- register(address circuits, uint256 tokenId, bytes32 label, string manifestPath) payable
  - factory.isCPU(circuits) 为真，否则 revert NotCPU()（自制 ERC-721 不能登记）
  - msg.sender == 安全 ownerOf(circuits, tokenId)：ownerOf 回滚 / 返回零地址（已销毁）→ NotHolder()
  - container = IHub(hub).accountOf(circuits, tokenId)
  - label != 0 且 domainBinding != 0 时要求 isLive(container)，否则 revert NotLive()；label==0 不查门槛
  - label 未占用或已被同一 container 占用；msg.value ≥ labelFee（label==0 则免费，labelFee 默认 0）
  - 切换标签时释放旧标签并 emit Released(container, oldLabel)
  - 记录 Service{circuits,tokenId,container,label,manifestPath,updatedAt}
- update(address circuits, uint256 tokenId, string manifestPath)   // 同样使用安全 ownerOf
- release(bytes32 label)   // holder 放弃；若电路已无持有人（token 销毁）则任何人可释放
- resolve(bytes32 label) view returns (address container)
- serviceOf(address container) view returns (Service)
- count() view; at(uint256 i) view returns (Service)
- isLive(address container) view returns (bool)   // 未配置门槛恒为 true；低级 staticcall，仅当成功、返回 ≥ 32 字节且首字恰为 1 时为 true；revert / 过短 / 0x02 等一律 false，本合约不回滚
- labelFee() view; factory() view; domainBinding() view; setLabelFee(uint256); setTreasury(address); withdraw()
- transferOwnership(address) 仅提名 pendingOwner；acceptOwnership() 由被提名者调用完成转移
- events: Registered(container, label, circuits, tokenId, manifestPath), Updated, Released, LabelFeeChanged, TreasuryChanged, OwnershipTransferStarted, OwnershipTransferred
- DOMAIN_SEPARATOR() view  // 供 Delegation 校验用
- verifyDelegation(address circuits, uint256 tokenId, address signer, uint64 expires, bytes sig) view returns (bool)

### TapeAPIEscrow.sol（不可升级，零协议费；Ownable 仅能更换金库地址，两步转移）
constructor(address bem, address hub, address treasury)   // 均非零；hub 用于 accountOf
常量：WITHDRAW_COOLDOWN = 48h，WITHDRAW_WINDOW = 7d，MAX_SESSION = 30d，DEFAULT_CONTRIBUTION_BPS = 100，MAX_CONTRIBUTION_BPS = 2000。
（v2，按提供者分账；决策理由见 spec/TAPI-22.md §3.3。v1 归档于 contracts/archive/。）

- fund(address provider, uint256 amount)                         // transferFrom；channel[msg.sender][provider] += amount；provider 不得为零或托管自身
- requestWithdraw(address provider, uint256 amount)              // amount ≤ channel；记录 {amount, now}，覆盖并重新计时旧请求；发出 WithdrawRequested
- cancelWithdraw(address provider)                               // 撤回本人对该通道的待处理提现请求（只可能有利于提供者）
- withdraw(address provider)                                     // 仅在 [requestedAt+48h, requestedAt+48h+7d] 内；付 min(所请求, 当前通道)；冷静期内的结算优先
- authorizeSession(address provider, address key, uint64 expires) // 按通道；expires ∈ (now, now+30d]；只可延长；**无撤销**——泄露损失以一个通道为上限，自然过期
- settle(consumer, provider, cumulative, expires, sig)
  - block.timestamp ≤ expires；签名者为 consumer 或 session[consumer][provider][signer] ≥ now
  - provider 不得为零或托管自身（BadProvider）
  - delta = cumulative − claimed > 0（NothingToSettle）；pay = min(delta, channel) > 0（InsufficientBalance）
  - contribution = pay × bps / 10000 → treasury（>0 时）；其余 → provider；claimed += pay；channel −= pay
  - **部分结算是合法流程**：提供者自愿赊账，余额到账后续结
- setContribution(circuits, tokenId, bps) / contributionOf / setTreasury / 两步所有权（同 v1）
- views：channelOf(c,p)、claimedOf(c,p)、sessionExpiry(c,p,key)、pendingWithdraw(c,p)、DOMAIN_SEPARATOR、VOUCHER_TYPEHASH、voucherDigest

提供者 MUST 监听 WithdrawRequested 并在冷静期内结算——这是它的全部保护，与 v1 的双窗口在实质上同构。
凭证的 EIP-712 结构与 v1 完全相同（consumer, provider, cumulative, expires），SDK 签名路径不变。

