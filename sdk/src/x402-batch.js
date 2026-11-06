// @experimental prototype: enforcement 'x402-batch'. The agent key's spending is bounded by an x402 batch-settlement
// channel (EVM binding, spec commit c2a8924e) on contracts already deployed that we did not write and have not reviewed
// (their repository carries external review reports we have not assessed). EOA payers only; no contribution or
// treasury; the service sets the withdraw delay (the client caps it); the contract has no session expiry (the SDK stops
// signing). Nothing here sends a transaction or pays gas for anyone. Outside the compatibility promise.
// 实验原型：x402 批量结算通道；合约非我们编写、未经我们审查。只收 EOA 付款方；不替任何人付 gas。
import { keccak_256 } from '@noble/hashes/sha3'
import { TapeAPIError } from './errors.js'
import { encodeParams, decodeParams, hexToBytes, toHex, bytesToHex, concatBytes, utf8ToBytes, isAddress, eqAddr, checksumAddress, ZERO_ADDRESS, selector } from './abi.js'
import { typedDigest, signDigest, recoverAddress, privateKeyToAddress } from './sig.js'

export const ENFORCEMENT_X402_BATCH = 'x402-batch'
// the canonical deployments of the scheme's EVM binding (the same addresses on every chain it lists) / 规范地址
export const X402_SETTLEMENT = '0x4020074e9dF2ce1deE5A9C1b5c3f541D02a10003'
export const X402_PERMIT2_COLLECTOR = '0x4020425FAf3B746C082C2f942b4E5159887B0005'
export const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3'
export const X402_SPEC_COMMIT = 'c2a8924eb5dfe53806352d73c46a87d2a9e34038'
export const X402_MIN_WITHDRAW_DELAY_S = 900          // the contract's MIN_WITHDRAW_DELAY
export const X402_MAX_WITHDRAW_DELAY_S = 30 * 86400   // the contract's MAX_WITHDRAW_DELAY
export const X402_DEFAULT_MAX_WITHDRAW_DELAY_S = 48 * 3600   // the client's cap by default (TAPI-22's cooldown)
export const X402_DEFAULT_SESSION_S = 3600            // how long a payer signs by default
export const X402_EOA_ONLY = 'x402-batch takes plain EOA payers only: a TapeOut container answers isValidSignature with 0x00000000 (BSC fork, block 129,111,153), so Permit2 refuses its deposit whatever payerAuthorizer is; an EOA with EIP-7702 code is refused too. Move the funds to a plain EOA first'

// small checks shared below: every amount the contract stores is a uint128, every address must be non-zero
// 下面共用的小检查：合约里的金额都是 uint128，地址不得为零
const ZERO32 = '0x' + '00'.repeat(32)
const HEX32 = /^0x[0-9a-fA-F]{64}$/
const UINT_RE = /^(0|[1-9][0-9]{0,38})$/
const U128 = (1n << 128n) - 1n
const kh = (s) => keccak_256(utf8ToBytes(s))
const bad = (msg, reason) => { throw new TapeAPIError('INVALID_ARGUMENT', msg, reason ? { reason } : undefined) }
const u128 = (v, name) => { const s = typeof v === 'bigint' ? v.toString() : String(v); if (!UINT_RE.test(s) || BigInt(s) > U128) bad(`${name} must be a uint128 (decimal string)`); return BigInt(s) }
const addr = (v, name) => { if (!isAddress(v) || eqAddr(v, ZERO_ADDRESS)) bad(`${name} must be a non-zero address`); return checksumAddress(v) }

// ---- EIP-712, as x402BatchSettlement and Permit2 hash it ----
// The type strings are copied from the contracts (spec commit c2a8924e); the tests pin every digest against `cast`
// and against values read from the deployed contracts. / 类型串照抄合约；测试把每个摘要与 cast 及链上读数逐字节对照
const CHANNEL_CONFIG_TYPEHASH = kh('ChannelConfig(address payer,address payerAuthorizer,address receiver,address receiverAuthorizer,address token,uint40 withdrawDelay,bytes32 salt)')
const VOUCHER_TYPEHASH = kh('Voucher(bytes32 channelId,uint128 maxClaimableAmount)')
const CLAIM_ENTRY_TYPEHASH = kh('ClaimEntry(bytes32 channelId,uint128 maxClaimableAmount,uint128 totalClaimed)')
const CLAIM_BATCH_TYPEHASH = kh('ClaimBatch(ClaimEntry[] claims)ClaimEntry(bytes32 channelId,uint128 maxClaimableAmount,uint128 totalClaimed)')
const P2_DOMAIN_TYPEHASH = kh('EIP712Domain(string name,uint256 chainId,address verifyingContract)')
const TOKEN_PERMISSIONS_TYPEHASH = kh('TokenPermissions(address token,uint256 amount)')
const PERMIT_WITNESS_TYPEHASH = kh('PermitWitnessTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline,DepositWitness witness)DepositWitness(bytes32 channelId)TokenPermissions(address token,uint256 amount)')
const DEPOSIT_WITNESS_TYPEHASH = kh('DepositWitness(bytes32 channelId)')
const domainOf = (chainId, settlement) => ({ name: 'x402 Batch Settlement', version: '1', chainId, verifyingContract: settlement })
const CFG_TYPES = ['address', 'address', 'address', 'address', 'address', 'uint40', 'bytes32']
const cfgValues = (c) => [c.payer, c.payerAuthorizer, c.receiver, c.receiverAuthorizer, c.token, c.withdrawDelay, c.salt]

// a channel's configuration, checked; payerAuthorizer is always a session key (0 would ask the payer's EIP-1271)
export function x402ChannelConfig(c = {}) {
  const d = c.withdrawDelay
  if (!Number.isSafeInteger(d) || d < X402_MIN_WITHDRAW_DELAY_S || d > X402_MAX_WITHDRAW_DELAY_S) bad(`withdrawDelay must be whole seconds from ${X402_MIN_WITHDRAW_DELAY_S} to ${X402_MAX_WITHDRAW_DELAY_S}`, 'x402-withdraw-delay-out-of-range')
  const salt = c.salt ?? ZERO32
  if (typeof salt !== 'string' || !HEX32.test(salt)) bad('salt must be a bytes32')
  return { payer: addr(c.payer, 'payer'), payerAuthorizer: addr(c.payerAuthorizer, 'payerAuthorizer (the session key)'), receiver: addr(c.receiver, 'receiver'), receiverAuthorizer: addr(c.receiverAuthorizer, 'receiverAuthorizer'), token: addr(c.token, 'token'), withdrawDelay: d, salt: salt.toLowerCase() }
}
// the channel id is the EIP-712 hash of its whole configuration: change any member (even the salt) and it is another
// channel / 通道 id 是整个配置的 EIP-712 哈希：任何一项不同就是另一条通道
export function x402ChannelId(chainId, settlement, config) {
  const c = x402ChannelConfig(config)
  return toHex(typedDigest(domainOf(chainId, settlement), keccak_256(encodeParams(['bytes32', ...CFG_TYPES], [CHANNEL_CONFIG_TYPEHASH, ...cfgValues(c)]))))
}
// what the session key (payerAuthorizer) signs: a cumulative ceiling for one channel, never a per-call amount
// 会话钥匙签的是一条通道的累计上限，不是单次金额
export function x402VoucherDigest(chainId, settlement, channelId, maxClaimableAmount) {
  return typedDigest(domainOf(chainId, settlement), keccak_256(encodeParams(['bytes32', 'bytes32', 'uint128'], [VOUCHER_TYPEHASH, channelId, u128(maxClaimableAmount, 'maxClaimableAmount')])))
}
// what the receiverAuthorizer signs when someone else submits the provider's claim (claimWithSignature)
// 由他人代交服务方的 claim 时，receiverAuthorizer 签的摘要
export function x402ClaimBatchDigest(chainId, settlement, rows) {
  const entries = rows.map((r) => keccak_256(encodeParams(['bytes32', 'bytes32', 'uint128', 'uint128'], [CLAIM_ENTRY_TYPEHASH, r.channelId, u128(r.maxClaimableAmount, 'maxClaimableAmount'), u128(r.totalClaimed, 'totalClaimed')])))
  return typedDigest(domainOf(chainId, settlement), keccak_256(encodeParams(['bytes32', 'bytes32'], [CLAIM_BATCH_TYPEHASH, keccak_256(concatBytes(...entries))])))
}
export function permit2DomainSeparator(chainId, permit2 = PERMIT2) {
  return keccak_256(encodeParams(['bytes32', 'bytes32', 'uint256', 'address'], [P2_DOMAIN_TYPEHASH, kh('Permit2'), BigInt(chainId), permit2]))
}
// the payer's Permit2 witness digest for a deposit; spender = the collector (Permit2's caller), witness = the channel id
export function x402DepositDigest(chainId, { token, amount, nonce, deadline, channelId, collector = X402_PERMIT2_COLLECTOR, permit2 = PERMIT2 }) {
  const permitted = keccak_256(encodeParams(['bytes32', 'address', 'uint256'], [TOKEN_PERMISSIONS_TYPEHASH, token, BigInt(amount)]))
  const witness = keccak_256(encodeParams(['bytes32', 'bytes32'], [DEPOSIT_WITNESS_TYPEHASH, channelId]))
  const struct = keccak_256(encodeParams(['bytes32', 'bytes32', 'address', 'uint256', 'uint256', 'bytes32'], [PERMIT_WITNESS_TYPEHASH, permitted, collector, BigInt(nonce), BigInt(deadline), witness]))
  return keccak_256(concatBytes(new Uint8Array([0x19, 0x01]), permit2DomainSeparator(chainId, permit2), struct))
}

// ---- unsigned transactions, each sent and paid for by the party it names / 各方自付 gas ----
const CFG_SIG = '(address,address,address,address,address,uint40,bytes32)'
const VC_SIG = `((${CFG_SIG},uint128),bytes,uint128)[]`
const CFG_T = { type: 'tuple', components: CFG_TYPES }
const VC_T = { type: 'tuple', components: [{ type: 'tuple', components: [CFG_T, 'uint128'] }, 'bytes', 'uint128'] }
const word = (n) => hexToBytes(BigInt(n).toString(16).padStart(64, '0'))
const call = (to, sig, bytes) => ({ to, data: selector(sig) + bytesToHex(bytes), value: '0x0' })
// abi.js has no arrays: a dynamic array of dynamic tuples is encoded here by hand (length, one offset per row, then the
// rows), as Solidity's ABI lays it out / abi.js 不支持数组：这里手写动态元组数组的编码（长度、各行偏移、各行内容）
function encodeRows(rows) {
  const encs = rows.map((r) => encodeParams(VC_T.components, [[cfgValues(x402ChannelConfig(r.config)), u128(r.maxClaimableAmount, 'maxClaimableAmount')], r.signature, u128(r.totalClaimed, 'totalClaimed')]))
  let off = 32 * encs.length
  const heads = encs.map((e) => { const w = word(off); off += e.length; return w })
  return concatBytes(word(encs.length), ...heads, ...encs)
}
const sigBytes = (s) => { const b = hexToBytes(s); return concatBytes(word(b.length), b, new Uint8Array((32 - (b.length % 32)) % 32)) }
// Every builder returns { to, data, value: '0x0' } and signs nothing: the payer sends approve, deposit (or has it
// relayed) and its withdrawal; the provider sends claim and settle. / 只构造未签名交易，谁的交易谁发、谁付 gas
export const x402Tx = Object.freeze({
  approvePermit2: (token, permit2 = PERMIT2) => call(addr(token, 'token'), 'approve(address,uint256)', encodeParams(['address', 'uint256'], [permit2, (1n << 256n) - 1n])),
  deposit: (settlement, config, { amount, nonce, deadline, signature, collector = X402_PERMIT2_COLLECTOR }) => call(settlement, `deposit(${CFG_SIG},uint128,address,bytes)`,
    encodeParams([CFG_T, 'uint128', 'address', 'bytes'], [cfgValues(x402ChannelConfig(config)), u128(amount, 'amount'), collector, encodeParams(['uint256', 'uint256', 'bytes', 'bytes'], [BigInt(nonce), BigInt(deadline), signature, '0x'])])),
  claim: (settlement, rows) => call(settlement, `claim(${VC_SIG})`, concatBytes(word(32), encodeRows(rows))),
  claimWithSignature: (settlement, rows, signature) => { const a = encodeRows(rows); return call(settlement, `claimWithSignature(${VC_SIG},bytes)`, concatBytes(word(64), word(64 + a.length), a, sigBytes(signature))) },
  settle: (settlement, receiver, token) => call(settlement, 'settle(address,address)', encodeParams(['address', 'address'], [receiver, token])),
  initiateWithdraw: (settlement, config, amount) => call(settlement, `initiateWithdraw(${CFG_SIG},uint128)`, encodeParams([CFG_T, 'uint128'], [cfgValues(x402ChannelConfig(config)), u128(amount, 'amount')])),
  finalizeWithdraw: (settlement, config) => call(settlement, `finalizeWithdraw(${CFG_SIG})`, encodeParams([CFG_T], [cfgValues(x402ChannelConfig(config))])),
  refund: (settlement, config, amount) => call(settlement, `refund(${CFG_SIG},uint128)`, encodeParams([CFG_T, 'uint128'], [cfgValues(x402ChannelConfig(config)), u128(amount, 'amount')])),
})

// `read(to, data)`: an eth_call returning hex. available = balance − totalClaimed − a pending withdrawal (never below 0)
export async function x402ChannelState(read, settlement, channelId) {
  const [c, p] = await Promise.all([read(settlement, selector('channels(bytes32)') + channelId.slice(2)), read(settlement, selector('pendingWithdrawals(bytes32)') + channelId.slice(2))])
  const [balance, totalClaimed] = decodeParams(['uint128', 'uint128'], c)
  const [amount, initiatedAt] = decodeParams(['uint128', 'uint40'], p)
  const unclaimed = balance - totalClaimed
  const pend = initiatedAt !== 0n ? amount : 0n
  return { channelId, balance, totalClaimed, unclaimed, pending: { amount, initiatedAt: Number(initiatedAt) }, available: unclaimed > pend ? unclaimed - pend : 0n }
}
// before any transaction: the payer must be an account without code (see X402_EOA_ONLY for why)
// 任何交易之前：付款方必须是无代码的账户（原因见 X402_EOA_ONLY）
export function x402CheckPayer(payer, code) {
  if (typeof code === 'string' && code !== '0x' && code !== '0x0' && code !== '') throw new TapeAPIError('AGENT_INVALID', `${payer} has code: ${X402_EOA_ONLY}`, { reason: 'x402-payer-not-eoa' })
  return true
}

// a service's terms by the CLIENT's rules: its withdrawDelay above maxWithdrawDelayS (default 48 h) is refused
export function x402Terms(t = {}, { container, maxWithdrawDelayS = X402_DEFAULT_MAX_WITHDRAW_DELAY_S } = {}) {
  if (!Number.isSafeInteger(maxWithdrawDelayS) || maxWithdrawDelayS < X402_MIN_WITHDRAW_DELAY_S) bad(`maxWithdrawDelayS must be whole seconds, at least ${X402_MIN_WITHDRAW_DELAY_S}`)
  const out = { settlement: addr(t.settlement ?? X402_SETTLEMENT, 'settlement'), receiver: addr(t.receiver, 'receiver'), receiverAuthorizer: addr(t.receiverAuthorizer, 'receiverAuthorizer'), token: addr(t.token, 'token'), withdrawDelay: t.withdrawDelay, salt: t.salt ?? ZERO32 }
  if (container !== undefined && !eqAddr(out.receiver, container)) bad(`the terms pay ${out.receiver}, not the service's container ${container}`, 'x402-receiver-mismatch')
  if (Number.isSafeInteger(out.withdrawDelay) && out.withdrawDelay > maxWithdrawDelayS) bad(`the service's withdrawDelay ${out.withdrawDelay} s is above this client's cap ${maxWithdrawDelayS} s (a withdrawal could take that long)`, 'x402-withdraw-delay-too-long')
  x402ChannelConfig({ payer: out.receiver, payerAuthorizer: out.receiver, ...out })   // the delay's range and the salt
  return out
}
// the terms configured for one provider, matched case-insensitively / 按地址（不分大小写）找某服务的条款
const termsFor = (terms, provider) => (terms && typeof terms === 'object' ? Object.entries(terms).find(([p]) => eqAddr(p, provider))?.[1] : undefined)

// the signer of a wire voucher { type: 'voucher', channelConfig, voucher: { channelId, maxClaimableAmount, signature } } if it
// is the config's payerAuthorizer (low s, v 27/28) and the id the config's; else null
export function x402VoucherSigner(chainId, settlement, w) {
  try {
    const cfg = x402ChannelConfig(w.channelConfig)
    const id = x402ChannelId(chainId, settlement, cfg)
    if (typeof w.voucher?.channelId !== 'string' || w.voucher.channelId.toLowerCase() !== id.toLowerCase()) return null
    const who = recoverAddress(x402VoucherDigest(chainId, settlement, id, w.voucher.maxClaimableAmount), w.voucher.signature, { strictV: true })
    return eqAddr(who, cfg.payerAuthorizer) ? who : null
  } catch { return null }
}

// the client's payer, of api.payer's shape (the limiter wraps it); it signs nothing after sessionExpiry (default now +
// 1 h): the contract has no expiry, this is the only one / 客户端付款器；会话到期后不再签名（合约没有到期）
export function x402Payer({ chainId, consumer, sessionKey, terms, sessionExpiry, maxWithdrawDelayS, store, clock = () => Math.floor(Date.now() / 1000) } = {}) {
  if (!Number.isSafeInteger(chainId) || chainId <= 0) bad('chainId must be a positive integer')
  const payerAddr = addr(consumer, 'consumer (the payer EOA)')
  if (typeof sessionKey !== 'string' || !HEX32.test(sessionKey)) bad('sessionKey must be the agent key\'s 32-byte private key')
  const signer = privateKeyToAddress(sessionKey)
  const end = sessionExpiry ?? clock() + X402_DEFAULT_SESSION_S
  if (!Number.isSafeInteger(end)) bad('sessionExpiry must be Unix seconds')
  if (store && (typeof store.get !== 'function' || typeof store.set !== 'function')) bad('store needs get(key) and set(key, value)')
  // the committed cumulative per channel survives in `store` (memory by default); one account per channel id
  // 每条通道的已提交累计额存在 store（默认内存）；每个通道 id 一个账户
  const mem = new Map()
  const st = store || { get: (k) => mem.get(k) ?? null, set: (k, v) => { mem.set(k, v) } }
  const accounts = new Map()
  // the channel this payer uses with a service: its terms (checked by the client's rules), the manifest's
  // payment.escrow equal to the terms' settlement, and this payer and session key / 与某服务所用的通道
  function channelOf(svc) {
    if (!svc?.container || !isAddress(svc.container)) bad('svc.container missing')
    const t = termsFor(terms, svc.container)
    if (!t) bad(`no x402 terms for ${svc.container}`, 'x402-terms-missing')
    const x = x402Terms(t, { container: svc.container, maxWithdrawDelayS })
    const esc = svc.manifest?.payment?.escrow
    if (svc.manifest && !eqAddr(esc ?? '', x.settlement)) bad(`${svc.container} names ${esc ?? 'no escrow'} in its manifest (payment.escrow), not the settlement ${x.settlement} of its terms`, 'x402-settlement-mismatch')
    const config = x402ChannelConfig({ payer: payerAddr, payerAuthorizer: signer, receiver: x.receiver, receiverAuthorizer: x.receiverAuthorizer, token: x.token, withdrawDelay: x.withdrawDelay, salt: x.salt })
    return { settlement: x.settlement, config, channelId: x402ChannelId(chainId, x.settlement, config) }
  }
  const acct = (svc) => {
    const ch = channelOf(svc)
    let a = accounts.get(ch.channelId)
    if (!a) { a = { ...ch, committed: 0n, loaded: false, inflight: new Set(), chain: Promise.resolve(), idle: [] }; accounts.set(ch.channelId, a) }
    return a
  }
  // one operation at a time per channel; `idle` waits (or refuses with noWait) while a voucher is in flight, so two
  // vouchers never race for the same cumulative / 每通道串行；有凭证在途时等待（或 noWait 即拒），避免两张凭证抢同一累计额
  const serial = (a, fn) => { const p = a.chain.then(fn, fn); a.chain = p.catch(() => {}); return p }
  const load = async (a) => { if (a.loaded) return; const v = await st.get(`${chainId}:${a.channelId}`); if (v != null && v !== '') { const b = BigInt(v); if (b > a.committed) a.committed = b } a.loaded = true }
  const persist = (a) => Promise.resolve(st.set(`${chainId}:${a.channelId}`, a.committed.toString()))
  const wake = (a) => { const go = a.idle.filter((w) => !a.inflight.size); a.idle = a.idle.filter((w) => !go.includes(w)); for (const w of go) w.go() }
  const idle = (a, waitMs, noWait) => {
    if (!a.inflight.size) return Promise.resolve()
    if (noWait) return Promise.reject(new TapeAPIError('PAYMENT_BUSY', 'a voucher of this channel is in flight', { data: { noWait: true } }))
    return new Promise((resolve, reject) => { const w = { go: () => { clearTimeout(t); resolve() } }; const t = setTimeout(() => { a.idle = a.idle.filter((x) => x !== w); reject(new TapeAPIError('PAYMENT_BUSY', `a voucher of this channel has been in flight for ${waitMs} ms`)) }, waitMs); a.idle.push(w) })
  }
  // the voucher as it goes on the wire: the channel's whole configuration (the provider recomputes the id from it)
  // and the signed ceiling / 线上凭证：带整份通道配置（服务方据此重算 id）与签名的上限
  const wire = (a, max) => ({ type: 'voucher', channelConfig: { ...a.config }, voucher: { channelId: a.channelId, maxClaimableAmount: max.toString(), signature: signDigest(x402VoucherDigest(chainId, a.settlement, a.channelId, max), sessionKey) } })
  const self = {
    consumer: payerAddr, signer, enforcement: ENFORCEMENT_X402_BATCH, sessionExpiry: end,
    channelOf,
    cumulativeOf: (svc) => acct(svc).committed,
    inflightOf: (svc) => acct(svc).inflight.size,
    whenFree: (svc, extra, waitMs = 60_000) => idle(acct(svc), Number(waitMs), false),
    setCumulative: (svc, v) => { const a = acct(svc); a.committed = BigInt(v); a.loaded = true; return persist(a) },
    // a provider's lastCumulative only with proof: our own voucher for exactly that figure / 只凭我方凭证采纳
    resync: (svc, last, evidence) => { const a = acct(svc); return serial(a, async () => {
      await load(a)
      const b = BigInt(last)
      if (b <= a.committed) return a.committed
      const v = evidence?.voucher
      const ok = v && String(v.maxClaimableAmount) === String(last) && eqAddr(x402VoucherSigner(chainId, a.settlement, { channelConfig: a.config, voucher: v }) ?? '', signer)
      if (!ok) throw new TapeAPIError('BAD_VOUCHER', `provider reported lastCumulative ${last} without proof; refusing to advance the local counter`)
      a.committed = b; await persist(a); return a.committed
    }) },
    // reserve: sign committed (or the highest in flight) + price, and hold it until commit or release; nothing is
    // signed after sessionExpiry / 预留：签「已提交（或在途最高）+ 价格」，直到 commit 或 release；会话到期后不再签
    reserve: (svc, price, extra) => { const a = acct(svc); return serial(a, async () => {
      await load(a)
      const amount = BigInt(price)
      if (amount <= 0n) bad('price must be positive')
      if (clock() > end) throw new TapeAPIError('BAD_VOUCHER', `session key ${signer} expired at ${end} (the SDK's expiry: the contract has none)`, { data: { reason: 'x402-session-expired' } })
      await idle(a, Number(extra?.waitMs ?? 60_000), extra?.noWait === true)
      let next = a.committed
      for (const n of a.inflight) if (n > next) next = n
      next += amount
      const voucher = wire(a, next)
      a.inflight.add(next)
      let done = false
      return {
        voucher, next, amount,
        commit() { if (done) return Promise.resolve(); done = true; a.inflight.delete(next); let p = Promise.resolve(); if (next > a.committed) { a.committed = next; p = persist(a).catch(() => {}) } wake(a); return p },
        release() { if (done) return; done = true; a.inflight.delete(next); wake(a) },
      }
    }) },
    async voucherFor(svc, price) { const lease = await self.reserve(svc, price); await lease.commit(); return lease.voucher },
  }
  return self
}

// The provider's acceptance, for createProvider({ enforcement }), one voucher per channel at a time: these terms, the
// payerAuthorizer's signature, maxClaimableAmount ≥ charged (or claimed) + price within what is available. It charges
// last + price, never more. A claim of what was already claimed is a silent no-op on chain: read the Claimed logs.
// 服务方收款核验：每通道串行；只按实际收费额 claim
export function x402Acceptance({ chainId, settlement = X402_SETTLEMENT, container, receiverAuthorizer, token, withdrawDelay, read, store, clock = () => Math.floor(Date.now() / 1000) } = {}) {
  if (typeof read !== 'function') bad('read(to, data) must be an eth_call returning hex')
  if (store && ['get', 'set', 'list'].some((f) => typeof store[f] !== 'function')) bad('store needs get(channelId), set(channelId, record) and list()')
  const terms = x402Terms({ settlement, receiver: container, receiverAuthorizer, token, withdrawDelay }, { maxWithdrawDelayS: X402_MAX_WITHDRAW_DELAY_S })
  const mem = new Map()
  const st = store || { get: (k) => mem.get(k) ?? null, set: (k, v) => { mem.set(k, v) }, list: () => [...mem.values()] }
  // per channel: a lock (vouchers are checked one at a time) and the cumulatives accepted but not yet committed
  // 每通道一把锁（逐张核验）与已接受未提交的累计额
  const locks = new Map()
  const held = new Map()
  const withLock = (k, fn) => { const p = (locks.get(k) ?? Promise.resolve()).then(fn, fn); locks.set(k, p.catch(() => {})); return p }
  async function verifyVoucher(w, price) {
    const no = (msg, reason, data) => { throw new TapeAPIError('BAD_VOUCHER', msg, { data: { price: price.toString(), reason, ...data } }) }
    if (!w || typeof w !== 'object' || w.type !== 'voucher' || !w.voucher) no('an x402 voucher { type: "voucher", channelConfig, voucher } is missing', 'malformed')
    let cfg
    try { cfg = x402ChannelConfig(w.channelConfig) } catch (e) { no(`channelConfig: ${e.message}`, 'malformed') }
    for (const k of ['receiver', 'receiverAuthorizer', 'token']) if (!eqAddr(cfg[k], terms[k])) no(`channelConfig.${k} is ${cfg[k]}, this service's is ${terms[k]}`, 'terms')
    if (cfg.withdrawDelay !== terms.withdrawDelay) no(`channelConfig.withdrawDelay is ${cfg.withdrawDelay}, this service's is ${terms.withdrawDelay}`, 'terms')
    let max
    try { max = u128(w.voucher.maxClaimableAmount, 'maxClaimableAmount') } catch (e) { no(e.message, 'malformed') }
    const who = x402VoucherSigner(chainId, terms.settlement, w)
    if (!who) no('bad voucher signature, or another channel', 'signature')
    const id = w.voucher.channelId.toLowerCase()
    // under the lock: last = the highest of what we charged, what is claimed on chain and what is held; the voucher must
    // cover last + price, and the channel must still hold it above what is claimed. A stale voucher's refusal carries, when
    // we hold one, the payer's own voucher for exactly `last`, so its payer can resync. / 锁内：last 取已收费、链上已
    // claim、在途三者最高；凭证须覆盖 last + 价格，通道余额须够；过期凭证的拒绝附上（若有）付款方自己恰好对 last 签过的凭证，供其 resync
    return withLock(id, async () => {
      const s = await x402ChannelState(read, terms.settlement, id)
      const rec = await st.get(id)
      const charged = rec ? BigInt(rec.charged) : 0n
      let last = charged > s.totalClaimed ? charged : s.totalClaimed
      for (const x of held.get(id) ?? []) if (x > last) last = x
      const proof = rec && BigInt(rec.charged) === last ? { channelId: id, maxClaimableAmount: rec.maxClaimableAmount, signature: rec.signature } : undefined
      if (max < last + price) no(`maxClaimableAmount ${max} < last ${last} + price ${price}`, 'stale', { lastCumulative: last.toString(), onChainClaimed: s.totalClaimed.toString(), ...(proof && BigInt(proof.maxClaimableAmount) === last ? { voucher: proof } : {}) })
      const next = last + price
      if (next - s.totalClaimed > s.available) no(`the channel cannot pay ${next}: ${s.available} available above ${s.totalClaimed} claimed`, 'funds')
      if (!held.has(id)) held.set(id, new Set())
      held.get(id).add(next)
      const clear = () => { const x = held.get(id); if (x) { x.delete(next); if (!x.size) held.delete(id) } }
      return {
        consumer: cfg.payer, signer: who, cumulative: next,
        commit: () => withLock(id, async () => {
          try { const cur = await st.get(id); if (!cur || BigInt(cur.charged) < next) await st.set(id, { channelId: id, config: cfg, charged: next.toString(), maxClaimableAmount: max.toString(), signature: w.voucher.signature, at: clock() }) } finally { clear() }
        }),
        release: clear,
      }
    })
  }
  return {
    name: ENFORCEMENT_X402_BATCH, terms: () => ({ ...terms, scheme: 'batch-settlement', spec: X402_SPEC_COMMIT }), verifyVoucher,
    // the rows still worth claiming: what we charged above what the chain says is claimed / 仍需 claim 的行
    async claimRows() {
      const out = []
      for (const r of await st.list()) {
        const s = await x402ChannelState(read, terms.settlement, r.channelId)
        if (BigInt(r.charged) > s.totalClaimed) out.push({ config: r.config, maxClaimableAmount: r.maxClaimableAmount, signature: r.signature, totalClaimed: r.charged })
      }
      return out
    },
    claimTx: (rows) => x402Tx.claim(terms.settlement, rows),
    settleTx: () => x402Tx.settle(terms.settlement, terms.receiver, terms.token),
  }
}
