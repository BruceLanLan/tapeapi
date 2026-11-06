// A fake x402BatchSettlement + Permit2DepositCollector + Permit2 + an ERC-20, in memory, for the x402-batch unit tests.
// It ports the semantics of x402BatchSettlement.sol at x402 commit c2a8924e and what the BSC fork drill observed
// (internal notes X402-FORK-DRILL §3): reverts by name, a claim at or below totalClaimed a silent no-op, finalize and
// refund capped to balance − totalClaimed, the refund nonce raised before the cap, Permit2 nonces single use, the
// deadline, and an address with code (a TapeOut container answers isValidSignature with 0) refused as a signer.
// It is a model, not the contract: the optional fork test (x402-batch-fork.test.mjs) runs the real one.
// 内存里的假 x402 批量结算 + Permit2 收款器 + Permit2 + ERC-20，移植自合约源码与分叉演练的观察；它是模型，不是合约。
import * as X from '../../src/x402-batch.js'
import { recoverAddress } from '../../src/sig.js'
import { decodeParams, encodeParams, hexToBytes, toHex, selector, eqAddr, checksumAddress, ZERO_ADDRESS } from '../../src/abi.js'

export class Revert extends Error { constructor(reason) { super(`reverts: ${reason}`); this.reason = reason } }
const CFG_T = { type: 'tuple', components: ['address', 'address', 'address', 'address', 'address', 'uint40', 'bytes32'] }
const VC_COMPONENTS = [{ type: 'tuple', components: [CFG_T, 'uint128'] }, 'bytes', 'uint128']
const cfgOf = (a) => ({ payer: a[0], payerAuthorizer: a[1], receiver: a[2], receiverAuthorizer: a[3], token: a[4], withdrawDelay: Number(a[5]), salt: a[6] })
const SEL = Object.fromEntries(Object.entries({
  approve: 'approve(address,uint256)',
  deposit: 'deposit((address,address,address,address,address,uint40,bytes32),uint128,address,bytes)',
  claim: 'claim((((address,address,address,address,address,uint40,bytes32),uint128),bytes,uint128)[])',
  claimWithSignature: 'claimWithSignature((((address,address,address,address,address,uint40,bytes32),uint128),bytes,uint128)[],bytes)',
  settle: 'settle(address,address)',
  initiateWithdraw: 'initiateWithdraw((address,address,address,address,address,uint40,bytes32),uint128)',
  finalizeWithdraw: 'finalizeWithdraw((address,address,address,address,address,uint40,bytes32))',
  refund: 'refund((address,address,address,address,address,uint40,bytes32),uint128)',
  channels: 'channels(bytes32)', pendingWithdrawals: 'pendingWithdrawals(bytes32)', refundNonce: 'refundNonce(bytes32)',
}).map(([k, s]) => [selector(s), k]))

export function createX402Fake({ chainId = 56, settlement = X.X402_SETTLEMENT, token, now = 1_791_000_000 } = {}) {
  const S = settlement.toLowerCase()
  const k = (a) => String(a).toLowerCase()
  const bal = new Map(), allow = new Map(), code = new Map(), nonces = new Set()
  const channels = new Map(), pending = new Map(), refundNonces = new Map(), receivers = new Map()
  const logs = []
  const clock = { t: now }
  const balOf = (a) => bal.get(k(a)) ?? 0n
  const move = (from, to, amt) => { if (balOf(from) < amt) throw new Revert('TRANSFER_FAILED'); bal.set(k(from), balOf(from) - amt); bal.set(k(to), balOf(to) + amt) }
  const ch = (id) => { if (!channels.has(id)) channels.set(id, { balance: 0n, totalClaimed: 0n }); return channels.get(id) }
  const pw = (id) => { if (!pending.has(id)) pending.set(id, { amount: 0n, initiatedAt: 0 }); return pending.get(id) }
  const rcv = (r, t) => { const kk = `${k(r)}:${k(t)}`; if (!receivers.has(kk)) receivers.set(kk, { totalClaimed: 0n, totalSettled: 0n }); return receivers.get(kk) }
  const idOf = (c) => X.x402ChannelId(chainId, settlement, c).toLowerCase()
  // OZ SignatureChecker and Permit2 ask an address with code for EIP-1271; a TapeOut container answers 0 (drill B0)
  const signedBy = (signer, digest, sig) => { if (code.has(k(signer))) return false; try { return eqAddr(recoverAddress(digest, sig, { strictV: true }), signer) } catch { return false } }
  const validCfg = (c) => {
    for (const f of ['payer', 'receiver', 'receiverAuthorizer', 'token']) if (eqAddr(c[f], ZERO_ADDRESS)) throw new Revert('InvalidChannel')
    if (c.withdrawDelay < X.X402_MIN_WITHDRAW_DELAY_S || c.withdrawDelay > X.X402_MAX_WITHDRAW_DELAY_S) throw new Revert('WithdrawDelayOutOfRange')
  }
  function deposit(sender, c, amount, collector, cd) {
    validCfg(c)
    if (amount === 0n) throw new Revert('ZeroDeposit')
    if (eqAddr(collector, ZERO_ADDRESS)) throw new Revert('InvalidCollector')
    if (!eqAddr(collector, X.X402_PERMIT2_COLLECTOR)) throw new Revert('unknown collector')
    const id = idOf(c)
    const [nonce, deadline, sig] = decodeParams(['uint256', 'uint256', 'bytes', 'bytes'], cd)
    // Permit2 permitWitnessTransferFrom, spender = the collector
    if (deadline < BigInt(clock.t)) throw new Revert('SignatureExpired')
    if (nonces.has(`${k(c.payer)}:${nonce}`)) throw new Revert('InvalidNonce')
    if (code.has(k(c.payer))) throw new Revert('InvalidContractSignature')
    if (!signedBy(c.payer, X.x402DepositDigest(chainId, { token: c.token, amount, nonce, deadline, channelId: id }), sig)) throw new Revert('InvalidSigner')
    if ((allow.get(`${k(c.payer)}:${k(X.PERMIT2)}`) ?? 0n) < amount) throw new Revert('TRANSFER_FROM_FAILED')
    move(c.payer, S, amount)
    nonces.add(`${k(c.payer)}:${nonce}`)
    ch(id).balance += amount
    logs.push({ event: 'Deposited', channelId: id, sender, amount })
  }
  function processClaim(sender, row) {
    const c = row.config, id = idOf(c), s = ch(id)
    if (row.totalClaimed <= s.totalClaimed) return   // a silent no-op (drill A4b, A4c)
    if (row.totalClaimed > row.maxClaimableAmount) throw new Revert('ClaimExceedsCeiling')
    if (row.totalClaimed > s.balance) throw new Revert('ClaimExceedsBalance')
    const digest = X.x402VoucherDigest(chainId, settlement, id, row.maxClaimableAmount)
    if (!eqAddr(c.payerAuthorizer, ZERO_ADDRESS)) { let who = null; try { who = recoverAddress(digest, row.signature, { strictV: true }) } catch { who = null } if (!who || !eqAddr(who, c.payerAuthorizer)) throw new Revert('InvalidSignature') }
    else if (!signedBy(c.payer, digest, row.signature)) throw new Revert('InvalidSignature')
    const delta = row.totalClaimed - s.totalClaimed
    s.totalClaimed = row.totalClaimed
    rcv(c.receiver, c.token).totalClaimed += delta
    logs.push({ event: 'Claimed', channelId: id, sender, claimAmount: delta, newTotalClaimed: row.totalClaimed })
  }
  const isReceiverSide = (who, c) => eqAddr(who, c.receiverAuthorizer) || eqAddr(who, c.receiver)
  function executeRefund(sender, c, amount) {
    if (amount === 0n) throw new Revert('ZeroRefund')
    const id = idOf(c)
    refundNonces.set(id, (refundNonces.get(id) ?? 0n) + 1n)   // raised before the cap
    const s = ch(id), avail = s.balance - s.totalClaimed
    const amt = amount > avail ? avail : amount
    if (amt === 0n) return
    s.balance -= amt
    const p = pw(id)
    if (p.initiatedAt !== 0) { if (amt >= p.amount) { p.amount = 0n; p.initiatedAt = 0 } else p.amount -= amt }
    logs.push({ event: 'Refunded', channelId: id, sender, amount: amt })
    move(S, c.payer, amt)
  }
  // every call is all or nothing, as a transaction: the state is restored when it reverts / 每次调用全有或全无
  const atomic = (fn) => { const snap = JSON.stringify([...[bal, allow, nonces, channels, pending, refundNonces, receivers].map((m) => [...m])], (kk, v) => (typeof v === 'bigint' ? `${v}n` : v)); try { return fn() } catch (e) { restore(snap); throw e } }
  function restore(snap) {
    const back = JSON.parse(snap, (kk, v) => (typeof v === 'string' && /^\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v))
    ;[bal, allow, nonces, channels, pending, refundNonces, receivers].forEach((m, i) => { m.clear(); for (const e of back[i]) Array.isArray(e) ? m.set(e[0], e[1]) : m.add(e) })
  }
  const rowsAt = (bytes, at) => {
    const n = Number(decodeParams(['uint256'], bytes, at)[0])
    return Array.from({ length: n }, (_, i) => {
      const off = Number(decodeParams(['uint256'], bytes, at + 32 + 32 * i)[0])
      const [[cfg, max], signature, total] = decodeParams(VC_COMPONENTS, bytes, at + 32 + off)
      return { config: cfgOf(cfg), maxClaimableAmount: max, signature, totalClaimed: total }
    })
  }
  const fake = {
    chainId, settlement: checksumAddress(settlement), token, clock, logs, code,
    mint(to, amount) { bal.set(k(to), balOf(to) + BigInt(amount)) },
    balanceOf: balOf,
    setCode(a, hex = '0x60006000fd') { if (hex) code.set(k(a), hex); else code.delete(k(a)) },
    getCode: async (a) => code.get(k(a)) ?? '0x',
    channel: (id) => ({ ...ch(k(id)) }), pendingOf: (id) => ({ ...pw(k(id)) }), receiver: (r, t) => ({ ...rcv(r, t) }), refundNonce: (id) => refundNonces.get(k(id)) ?? 0n,
    /** eth_call to the settlement: channels, pendingWithdrawals, refundNonce / 只读调用 */
    read: async (to, data) => {
      if (!eqAddr(to, settlement)) throw new Revert('no such contract')
      const id = '0x' + data.slice(10, 74).toLowerCase(), f = SEL[data.slice(0, 10)]
      if (f === 'channels') { const s = ch(id); return toHex(encodeParams(['uint128', 'uint128'], [s.balance, s.totalClaimed])) }
      if (f === 'pendingWithdrawals') { const p = pw(id); return toHex(encodeParams(['uint128', 'uint40'], [p.amount, BigInt(p.initiatedAt)])) }
      if (f === 'refundNonce') return toHex(encodeParams(['uint256'], [refundNonces.get(id) ?? 0n]))
      throw new Revert('unknown view')
    },
    /** a transaction { to, data } sent by `from` (who pays its gas) / 由 from 发出的交易 */
    send(from, tx) {
      const f = SEL[tx.data.slice(0, 10)], b = hexToBytes('0x' + tx.data.slice(10))
      return atomic(() => {
        if (f === 'approve') { if (!eqAddr(tx.to, token)) throw new Revert('not the token'); const [sp, amt] = decodeParams(['address', 'uint256'], b); allow.set(`${k(from)}:${k(sp)}`, amt); return }
        if (!eqAddr(tx.to, settlement)) throw new Revert('not the settlement')
        if (f === 'deposit') { const [c, amount, collector, cd] = decodeParams([CFG_T, 'uint128', 'address', 'bytes'], b); return deposit(from, cfgOf(c), amount, collector, cd) }
        if (f === 'claim') {
          const rows = rowsAt(b, Number(decodeParams(['uint256'], b, 0)[0]))
          if (!rows.length) throw new Revert('EmptyBatch')
          for (const r of rows) { if (!isReceiverSide(from, r.config)) throw new Revert('NotAuthorizedToClaim'); processClaim(from, r) }
          return
        }
        if (f === 'claimWithSignature') {
          const [o1, o2] = decodeParams(['uint256', 'uint256'], b)
          const rows = rowsAt(b, Number(o1)), [sig] = decodeParams(['bytes'], b.subarray(Number(o2) - 32), 0)
          if (!rows.length) throw new Revert('EmptyBatch')
          const auth = rows[0].config.receiverAuthorizer
          const digest = X.x402ClaimBatchDigest(chainId, settlement, rows.map((r) => ({ channelId: idOf(r.config), maxClaimableAmount: r.maxClaimableAmount, totalClaimed: r.totalClaimed })))
          if (!signedBy(auth, digest, sig)) throw new Revert('InvalidSignature')
          for (const r of rows) { if (!eqAddr(r.config.receiverAuthorizer, auth)) throw new Revert('NotReceiverAuthorizer'); processClaim(from, r) }
          return
        }
        if (f === 'settle') {
          const [r, t] = decodeParams(['address', 'address'], b), s = rcv(r, t), amt = s.totalClaimed - s.totalSettled
          if (amt === 0n) return
          s.totalSettled = s.totalClaimed; move(S, r, amt); logs.push({ event: 'Settled', receiver: r, amount: amt }); return
        }
        if (f === 'initiateWithdraw') {
          const [cr, amount] = decodeParams([CFG_T, 'uint128'], b), c = cfgOf(cr)
          if (!eqAddr(from, c.payer) && !eqAddr(from, c.payerAuthorizer)) throw new Revert('InvalidChannel')
          if (amount === 0n) throw new Revert('NothingToWithdraw')
          const id = idOf(c), p = pw(id)
          if (p.initiatedAt !== 0) throw new Revert('WithdrawalAlreadyPending')
          const s = ch(id)
          if (amount > s.balance - s.totalClaimed) throw new Revert('WithdrawAmountExceedsAvailable')
          p.amount = amount; p.initiatedAt = clock.t; return
        }
        if (f === 'finalizeWithdraw') {
          const [cr] = decodeParams([CFG_T], b), c = cfgOf(cr)
          if (!eqAddr(from, c.payer) && !eqAddr(from, c.payerAuthorizer)) throw new Revert('NotAuthorizedToFinalizeWithdraw')
          const id = idOf(c), p = pw(id)
          if (p.initiatedAt === 0) throw new Revert('WithdrawalNotPending')
          if (clock.t < p.initiatedAt + c.withdrawDelay) throw new Revert('WithdrawDelayNotElapsed')
          const s = ch(id), avail = s.balance - s.totalClaimed, amt = p.amount > avail ? avail : p.amount
          p.amount = 0n; p.initiatedAt = 0; s.balance -= amt
          if (amt > 0n) move(S, c.payer, amt)
          return
        }
        if (f === 'refund') { const [cr, amount] = decodeParams([CFG_T, 'uint128'], b), c = cfgOf(cr); if (!isReceiverSide(from, c)) throw new Revert('NotAuthorizedToRefund'); return executeRefund(from, c, amount) }
        throw new Revert(`unknown call ${tx.data.slice(0, 10)}`)
      })
    },
  }
  return fake
}
