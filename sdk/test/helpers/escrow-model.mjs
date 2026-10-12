// Container agents, phase 1, M4 (experimental): the v3 escrow's state changes, modelled on the agent fake chain, so that an
// end-to-end test can "include" the transactions the holder, the provider and an attacker send: approve on the token,
// fund, authorizeSession, requestWithdraw, cancelWithdraw, withdraw and settle on the escrow, decoded from their own
// calldata, with the contract's checks and reverts (contracts/src/TapeAPIEscrow.sol, settle L275-302). A model, not the
// contract: contracts/test/Phase1Spend.t.sol executes the very same transactions on the unchanged v3 and must reach the
// same state. One escrow; channels are the shared fake chain's (consumer, provider) book. Nothing is signed or broadcast.
// 阶段 1 的 M4：在代理假链上模拟 v3 托管的状态变化，按交易自己的 calldata 解码并执行合约的检查与回滚。只是模型：
// Phase1Spend.t.sol 在未改的 v3 上执行同样的交易，必须得到同样的状态。不签名、不广播。
import { selector, decodeParams, hexToBytes, eqAddr } from '../../src/abi.js'
import { voucherDigest, recoverAddress } from '../../src/sig.js'

const COOLDOWN = 48n * 3600n, WINDOW = 7n * 86400n, MAX_SESSION = 30n * 86400n
const SEL = Object.fromEntries(['approve(address,uint256)', 'fund(address,uint256)', 'authorizeSession(address,address,uint64)', 'requestWithdraw(address,uint256)', 'cancelWithdraw(address)', 'withdraw(address)', 'settle(address,address,uint256,uint64,bytes)'].map((s) => [selector(s), s]))
const TYPES = {
  'approve(address,uint256)': ['address', 'uint256'], 'fund(address,uint256)': ['address', 'uint256'],
  'authorizeSession(address,address,uint64)': ['address', 'address', 'uint64'], 'requestWithdraw(address,uint256)': ['address', 'uint256'],
  'cancelWithdraw(address)': ['address'], 'withdraw(address)': ['address'], 'settle(address,address,uint256,uint64,bytes)': ['address', 'address', 'uint256', 'uint64', 'bytes'],
}
export class EscrowRevert extends Error { constructor(name) { super(`reverted: ${name}`); this.revert = name } }

/**
 * @param x       createAgentChain() world
 * @param o       { escrow, token, clock (() => Unix seconds), chainId (56), bps (the contribution, default 100 = 1%) }
 * send(from, tx) applies one transaction ({ to, data }) as `from` sends it, or throws EscrowRevert; `sent` lists them all.
 */
export function createEscrowModel(x, { escrow, token, clock, chainId = 56, bps = 100n } = {}) {
  const st = x.chain.state
  const k2 = (a, b) => `${a.toLowerCase()}:${b.toLowerCase()}`
  const k3 = (a, b, c) => `${a.toLowerCase()}:${b.toLowerCase()}:${c.toLowerCase()}`
  const allow = new Map()
  const bal = (a) => st.balances.get(a.toLowerCase()) ?? 0n
  const setBal = (a, v) => st.balances.set(a.toLowerCase(), v)
  const ch = (c, p) => st.channels.get(k2(c, p)) ?? 0n
  const claimed = (c, p) => st.claimed.get(k2(c, p)) ?? 0n
  const pending = (c, p) => st.pendingWithdraws.get(k2(c, p)) ?? [0n, 0n]
  const session = (c, p, k) => st.sessions.get(k3(c, p, k)) ?? 0n
  const sent = []
  let accrued = 0n
  const fail = (name) => { throw new EscrowRevert(name) }
  function send(from, tx) {
    const data = String(tx.data).toLowerCase()
    const sig = SEL[data.slice(0, 10)]
    if (!sig) throw new Error(`the model does not know ${data.slice(0, 10)}`)
    const a = decodeParams(TYPES[sig], hexToBytes('0x' + data.slice(10)))
    const now = BigInt(clock())
    const name = sig.slice(0, sig.indexOf('('))
    if (name === 'approve') {
      if (!eqAddr(tx.to, token)) throw new Error('approve is sent to the token')
      allow.set(k2(from, a[0]), a[1]); x.setAllowance(token, from, a[0], a[1])
    } else {
      if (!eqAddr(tx.to, escrow)) throw new Error(`${name} is sent to the escrow`)
      if (name === 'fund') {
        const [provider, amount] = a
        if (amount === 0n) fail('ZeroAmount')
        if (eqAddr(provider, escrow) || /^0x0{40}$/i.test(provider)) fail('BadProvider')
        const al = allow.get(k2(from, escrow)) ?? 0n
        if (al < amount || bal(from) < amount) fail('TransferFailed')
        allow.set(k2(from, escrow), al - amount); x.setAllowance(token, from, escrow, al - amount)
        setBal(from, bal(from) - amount); setBal(escrow, bal(escrow) + amount)
        x.chain.setChannel(from, provider, ch(from, provider) + amount)
      } else if (name === 'authorizeSession') {
        const [provider, key, expires] = a
        if (/^0x0{40}$/i.test(key)) fail('ZeroAddress')
        if (expires <= now) fail('Expired')
        if (expires > now + MAX_SESSION) fail('SessionTooLong')
        if (expires < session(from, provider, key)) fail('SessionShorteningNotSupported')
        x.chain.setSession(from, provider, key, expires)
      } else if (name === 'requestWithdraw') {
        const [provider, amount] = a
        if (amount === 0n) fail('ZeroAmount')
        if (amount > ch(from, provider)) fail('InsufficientBalance')
        x.chain.setPendingWithdraw(from, provider, amount, now)
      } else if (name === 'cancelWithdraw') {
        if (pending(from, a[0])[1] === 0n) fail('NoPendingWithdraw')
        x.chain.setPendingWithdraw(from, a[0], 0n, 0n)
      } else if (name === 'withdraw') {
        const [provider] = a
        const [amt, at] = pending(from, provider)
        if (amt === 0n) fail('NoPendingWithdraw')
        if (now < at + COOLDOWN) fail('CooldownActive')
        if (now > at + COOLDOWN + WINDOW) fail('WithdrawWindowClosed')
        const b = ch(from, provider)
        const out = amt > b ? b : amt
        x.chain.setPendingWithdraw(from, provider, 0n, 0n)
        if (out === 0n) fail('InsufficientBalance')
        x.chain.setChannel(from, provider, b - out)
        setBal(escrow, bal(escrow) - out); setBal(from, bal(from) + out)
      } else if (name === 'settle') {
        const [consumer, provider, cumulative, expires, s] = a
        if (now > expires) fail('Expired')
        let signer
        try { signer = recoverAddress(voucherDigest(chainId, escrow, { consumer, provider, cumulative, expires: Number(expires) }), s) } catch { fail('BadSignature') }
        if (!eqAddr(signer, consumer) && session(consumer, provider, signer) < now) fail('BadSignature')
        const already = claimed(consumer, provider)
        if (cumulative <= already) fail('NothingToSettle')
        const delta = cumulative - already, b = ch(consumer, provider)
        const pay = delta > b ? b : delta
        if (pay === 0n) fail('InsufficientBalance')
        const contribution = (pay * BigInt(bps)) / 10_000n
        x.chain.setClaimed(consumer, provider, already + pay)
        x.chain.setChannel(consumer, provider, b - pay)
        accrued += contribution
        setBal(escrow, bal(escrow) - (pay - contribution)); setBal(provider, bal(provider) + pay - contribution)
      }
    }
    sent.push({ from, to: tx.to, data: tx.data, at: Number(now), name })
    st.block += 1
    return name
  }
  return {
    send, sent, balanceOf: bal, accrued: () => accrued,
    channelOf: ch, claimedOf: claimed, pendingOf: pending, sessionOf: session,
    allowanceOf: (owner) => allow.get(k2(owner, escrow)) ?? 0n,
  }
}
