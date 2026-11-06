// @experimental prototype: enforcement 'x402-batch' (sdk/src/x402-batch.js). Known answers first: what the deployed
// x402BatchSettlement and Permit2 returned on the BSC fork drill (getChannelId, DOMAIN_SEPARATOR; internal notes
// X402-FORK-DRILL §1, §2) and what `cast` (Foundry, an independent encoder) gives for every digest and every call this SDK
// builds. Then the whole loop on a fake contract that ports x402BatchSettlement's semantics (helpers/x402-fake.mjs):
// the payer's approve and deposit, the agent key's vouchers, the provider's acceptance, claim and settle, a capped
// withdrawal; the client rules (EOA payers only, the withdraw-delay cap, the SDK's session expiry); the spend limiter and
// the budget around the x402 payer; the kit's verifyMandate and createProvider({ enforcement }). Keys are anvil's public
// test keys. Nothing here touches a network.
// 实验原型 x402-batch 的单元测试：先对拍分叉演练的链上读数与 cast；再在移植合约语义的假合约上跑完整一圈。不连任何网络。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as agent from '../src/agent-public.js'
import { keccak256, toHex, eqAddr, selector } from '../src/abi.js'
import { signDigest, privateKeyToAddress } from '../src/sig.js'
import { createSpendLimiter, spendRecord, spendRecheck } from '../src/agent-pay.js'
import { createBudget, memoryBudgetStore } from '../src/budget.js'
import { createX402Fake, Revert } from './helpers/x402-fake.mjs'
import { standardWorld, mandateOf, happyThread, KEYS, addrOf, S, RPC, NOW, BEM_TOKEN, nameEscrow } from './helpers/agent-chain.mjs'

const X = agent
const SET = X.X402_SETTLEMENT
const BEM = '0x5ce033B2bFCa3Af30b3e8C8457DeaF776A8b695a'
// anvil's public test keys (the drill's roles) / anvil 公开测试私钥（演练中的角色）
const PK = {
  payer: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  session: '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  receiver: '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
  receiverAuth: '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a',
  relayer: '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba',
}
const A = Object.fromEntries(Object.entries(PK).map(([k, v]) => [k, privateKeyToAddress(v)]))
const ZERO32 = '0x' + '00'.repeat(32)
const CFG_A = { payer: A.payer, payerAuthorizer: A.session, receiver: A.receiver, receiverAuthorizer: A.receiverAuth, token: BEM, withdrawDelay: 900, salt: ZERO32 }
const hx = (b) => (typeof b === 'string' ? b : toHex(b))
const kOf = (data) => toHex(keccak256(data))

test('x402-batch: known answers from the BSC fork (getChannelId, Permit2 DOMAIN_SEPARATOR) and from cast for every digest', () => {
  assert.equal(X.x402ChannelId(56, SET, CFG_A), '0xf1e90f8ee2f39b705451e8d9dd7ae03dfff07d91d7d313579acc02643ecb1ea8', 'drill: channelId A, local == onchain')
  assert.equal(hx(X.permit2DomainSeparator(56)), '0x4142cc3c823f819c467fa4437d637fe20589a31dfcd1da2ff22292c9ed9344e7', 'drill: Permit2 DOMAIN_SEPARATOR on BSC')
  const id = X.x402ChannelId(56, SET, CFG_A)
  assert.equal(hx(X.x402VoucherDigest(56, SET, id, 3000000n)), '0x97a7d2e8f0f7ecc9c5f45f1c9425d1de15f255375030ef12ee73d2eb38906b5c')
  assert.equal(hx(X.x402ClaimBatchDigest(56, SET, [{ channelId: id, maxClaimableAmount: 3000000n, totalClaimed: 2500000n }])), '0x5370544c4a938510fed2e7ecc1147f874137c810d91347e95b0634b5f7d3f90e')
  assert.equal(hx(X.x402DepositDigest(56, { token: BEM, amount: 1000000000n, nonce: 0, deadline: 2n ** 48n, channelId: id })), '0x437ec13cd9c081a96e0aaef4c15a1eb7292905585403b814c4247b30c22f9006')
  // another chain is another channel (the domain's chainId) / 换链即换通道
  assert.notEqual(X.x402ChannelId(8453, SET, CFG_A), id)
})

test('x402-batch: every call this SDK builds is byte for byte what cast calldata builds (keccak of the calldata)', () => {
  const sig = '0x' + '11'.repeat(32) + '22'.repeat(32) + '1b'
  const rows = [{ config: CFG_A, maxClaimableAmount: 3000000n, signature: sig, totalClaimed: 2500000n }, { config: { ...CFG_A, salt: '0x' + '00'.repeat(31) + '01' }, maxClaimableAmount: 5n, signature: sig, totalClaimed: 4n }]
  const want = {
    claim: [X.x402Tx.claim(SET, rows), '0x7fccb24f4b50d0b4d3a8c052cb0a665a42680e8d397bc841bc2c623e794ddd80'],
    claimWithSignature: [X.x402Tx.claimWithSignature(SET, rows, sig), '0x704d01d8b3397a69f2daea655f155031eaa8301165f6f81fe9a5622c9aa636ba'],
    deposit: [X.x402Tx.deposit(SET, CFG_A, { amount: 1000000000n, nonce: 0, deadline: 2n ** 48n, signature: sig }), '0x79632474503f39b7fd403b803acc85afcb7d9f9c14c66b783864228c1753b0f3'],
    initiateWithdraw: [X.x402Tx.initiateWithdraw(SET, CFG_A, 5n), '0x7eb310d0bd3f4ea305db07bfb3ee9c2b814efac6e2a09b5ae635885ae0ad8c15'],
    finalizeWithdraw: [X.x402Tx.finalizeWithdraw(SET, CFG_A), '0x48ffe088ec16f526d98885e311e6568b2195d71f7acea921c72395aa9aaa05a3'],
    refund: [X.x402Tx.refund(SET, CFG_A, 7n), '0x73ba6b950935cc44cbab3f33c0cc55a6df397597c59fdbbe36c39bc80966b990'],
    settle: [X.x402Tx.settle(SET, A.receiver, BEM), '0x0d71b6e59af7bbf35f9b1a6f8c1a3612e1a345a096987d0587efc939c88e42c3'],
    approvePermit2: [X.x402Tx.approvePermit2(BEM), '0x33eaef8fd2e8c79fe84b56f09c7be092913b640ab9b1c0614877f7cb367235c7'],
  }
  for (const [name, [tx, h]] of Object.entries(want)) {
    assert.equal(kOf(tx.data), h, name)
    assert.equal(tx.value, '0x0', `${name}: no value is ever attached`)
  }
  assert.equal(want.approvePermit2[0].to, BEM, 'approve goes to the token, from the payer')
})

test('x402-batch: the channel configuration keeps the contract\'s range and a session key; the client caps the service\'s delay (default 48 h)', () => {
  const reason = (fn) => { try { fn() } catch (e) { return e.data?.reason ?? e.code } return null }
  assert.equal(reason(() => X.x402ChannelConfig({ ...CFG_A, withdrawDelay: 899 })), 'x402-withdraw-delay-out-of-range')
  assert.equal(reason(() => X.x402ChannelConfig({ ...CFG_A, withdrawDelay: 2592001 })), 'x402-withdraw-delay-out-of-range')
  assert.equal(reason(() => X.x402ChannelConfig({ ...CFG_A, payerAuthorizer: '0x' + '00'.repeat(20) })), 'INVALID_ARGUMENT', 'payerAuthorizer 0 (the payer\'s EIP-1271) is refused')
  const t = { receiver: A.receiver, receiverAuthorizer: A.receiverAuth, token: BEM }
  assert.equal(X.X402_DEFAULT_MAX_WITHDRAW_DELAY_S, 172800)
  assert.equal(X.x402Terms({ ...t, withdrawDelay: 172800 }).withdrawDelay, 172800, 'exactly 48 h is allowed')
  assert.equal(reason(() => X.x402Terms({ ...t, withdrawDelay: 172801 })), 'x402-withdraw-delay-too-long')
  assert.equal(X.x402Terms({ ...t, withdrawDelay: 3 * 86400 }, { maxWithdrawDelayS: 3 * 86400 }).withdrawDelay, 259200, 'the cap is configurable')
  assert.equal(reason(() => X.x402Terms({ ...t, withdrawDelay: 3600 }, { container: '0x' + '5e'.repeat(20) })), 'x402-receiver-mismatch')
  assert.equal(X.x402Terms({ ...t, withdrawDelay: 3600 }).settlement, SET, 'the canonical settlement by default')
})

test('x402-batch: a payer with code is refused with the reason (a TapeOut container answers isValidSignature with 0; an EIP-7702 EOA too)', () => {
  assert.equal(X.x402CheckPayer(A.payer, '0x'), true)
  for (const code of ['0x60006000fd', '0xef01008a67b5020ee254ef48e3b6a04927f39baf7e408a']) {
    assert.throws(() => X.x402CheckPayer(A.payer, code), (e) => e.code === 'AGENT_INVALID' && e.data.reason === 'x402-payer-not-eoa' && /isValidSignature/.test(e.message) && /7702/.test(e.message))
  }
})

// ---- the whole loop on the fake contract / 在假合约上跑完整一圈 ----
const PRICE = 1_000_000n   // 0.01 BEM
const svc = { container: A.receiver, manifest: { payment: { escrow: SET } } }
const TERMS = { [A.receiver]: { receiver: A.receiver, receiverAuthorizer: A.receiverAuth, token: BEM, withdrawDelay: 3600 } }
function loop({ deposit = 10n * 100_000_000n, sessionExpiry = NOW + 600, clock } = {}) {
  const fake = createX402Fake({ token: BEM, now: NOW })
  fake.mint(A.payer, 100n * 100_000_000n)
  const now = clock ?? (() => fake.clock.t)
  const payer = X.x402Payer({ chainId: 56, consumer: A.payer, sessionKey: PK.session, terms: TERMS, sessionExpiry, clock: now })
  const { config, channelId } = payer.channelOf(svc)
  // the payer's own transactions: approve(Permit2) once, then a deposit it signs (anyone may send it)
  fake.send(A.payer, X.x402Tx.approvePermit2(BEM))
  if (deposit) {
    const sig = signDigest(X.x402DepositDigest(56, { token: BEM, amount: deposit, nonce: 0, deadline: NOW + 3600, channelId }), PK.payer)
    fake.send(A.relayer, X.x402Tx.deposit(SET, config, { amount: deposit, nonce: 0, deadline: NOW + 3600, signature: sig }))
  }
  const acc = X.x402Acceptance({ chainId: 56, container: A.receiver, receiverAuthorizer: A.receiverAuth, token: BEM, withdrawDelay: 3600, read: fake.read, clock: now })
  return { fake, payer, acc, config, channelId }
}
const badWith = (p, reason) => assert.rejects(p, (e) => { assert.equal(e.code, 'BAD_VOUCHER', e.message); assert.equal(e.data?.reason, reason, e.message); return true })

test('x402-batch loop: deposit through Permit2, vouchers by the agent key, the provider charges, claims and settles; it pays exactly what was charged', async () => {
  const { fake, payer, acc, config, channelId } = loop()
  assert.equal(fake.channel(channelId).balance, 10n * 100_000_000n)
  assert.equal(fake.balanceOf(A.payer), 90n * 100_000_000n)
  for (let i = 1n; i <= 3n; i++) {
    const lease = await payer.reserve(svc, PRICE)
    assert.equal(lease.voucher.voucher.maxClaimableAmount, (i * PRICE).toString())
    assert.equal(lease.voucher.voucher.channelId, channelId)
    const got = await acc.verifyVoucher(lease.voucher, PRICE)
    assert.equal(got.consumer, A.payer); assert.equal(got.signer, A.session); assert.equal(got.cumulative, i * PRICE)
    await got.commit(); await lease.commit()
  }
  const rows = await acc.claimRows()
  assert.equal(rows.length, 1); assert.equal(rows[0].totalClaimed, (3n * PRICE).toString())
  assert.throws(() => fake.send(A.relayer, acc.claimTx(rows)), (e) => e.reason === 'NotAuthorizedToClaim', 'only the receiver side claims')
  fake.send(A.receiver, acc.claimTx(rows))
  assert.equal(fake.channel(channelId).totalClaimed, 3n * PRICE)
  // the same claim again is a silent no-op on chain (drill A4b): no Claimed log / 重放静默无操作
  const before = fake.logs.length
  fake.send(A.receiver, acc.claimTx(rows))
  assert.equal(fake.logs.length, before, 'no Claimed log: the provider must read the logs, not the receipt status')
  assert.deepEqual(await acc.claimRows(), [], 'nothing left to claim')
  fake.send(A.relayer, acc.settleTx())   // anyone may settle; the provider pays its own gas
  assert.equal(fake.balanceOf(A.receiver), 3n * PRICE)
  assert.equal(config.payerAuthorizer, A.session)
})

test('x402-batch loop: the provider refuses another terms, another signer, a stale cumulative (with our own voucher as proof), a short channel', async () => {
  const { fake, payer, acc, config, channelId } = loop({ deposit: 2n * PRICE })
  const l1 = await payer.reserve(svc, PRICE)
  // another receiverAuthorizer in the config / 配置里换了 receiverAuthorizer
  await badWith(acc.verifyVoucher({ ...l1.voucher, channelConfig: { ...l1.voucher.channelConfig, receiverAuthorizer: A.relayer } }, PRICE), 'terms')
  // signed by the payer, not the session key / 由付款方而不是会话钥匙签
  await badWith(acc.verifyVoucher({ ...l1.voucher, voucher: { ...l1.voucher.voucher, signature: signDigest(X.x402VoucherDigest(56, SET, channelId, PRICE), PK.payer) } }, PRICE), 'signature')
  // a voucher for a raised amount without a new signature / 改了金额没重签
  await badWith(acc.verifyVoucher({ ...l1.voucher, voucher: { ...l1.voucher.voucher, maxClaimableAmount: (9n * PRICE).toString() } }, PRICE), 'signature')
  const ok1 = await acc.verifyVoucher(l1.voucher, PRICE); await ok1.commit(); await l1.commit()
  // a second payer instance (a restart without its store) signs the same cumulative again: stale, with proof
  const fresh = X.x402Payer({ chainId: 56, consumer: A.payer, sessionKey: PK.session, terms: TERMS, sessionExpiry: NOW + 600, clock: () => NOW })
  const l2 = await fresh.reserve(svc, PRICE)
  const stale = await acc.verifyVoucher(l2.voucher, PRICE).catch((e) => e)
  assert.equal(stale.data.reason, 'stale'); assert.equal(stale.data.lastCumulative, PRICE.toString())
  l2.release()
  assert.equal(await fresh.resync(svc, stale.data.lastCumulative, stale.data), PRICE, 'our own voucher for that figure is proof')
  await assert.rejects(fresh.resync(svc, (50n * PRICE).toString(), {}), (e) => e.code === 'BAD_VOUCHER', 'a bare number is not')
  // the channel holds 2 × PRICE: a third call does not fit / 通道只够两次
  const l3 = await fresh.reserve(svc, PRICE); const ok3 = await acc.verifyVoucher(l3.voucher, PRICE); await ok3.commit(); await l3.commit()
  const l4 = await fresh.reserve(svc, PRICE)
  await badWith(acc.verifyVoucher(l4.voucher, PRICE), 'funds')
  l4.release()
  // a withdrawal started now: what was charged and not yet claimed is the provider's exposure until it claims inside the
  // window (drill A8) / 已收费未 claim 的部分是服务方的风险，须在窗口内 claim
  fake.send(A.session, X.x402Tx.initiateWithdraw(SET, config, 1n))
  assert.equal((await X.x402ChannelState(fake.read, SET, channelId)).available, 2n * PRICE - 1n)
  fake.send(A.receiver, acc.claimTx(await acc.claimRows()))
  assert.equal(fake.channel(channelId).totalClaimed, 2n * PRICE)
  const s = await X.x402ChannelState(fake.read, SET, channelId)
  assert.equal(s.available, 0n, 'all claimed: the pending withdrawal finds nothing')
  fake.clock.t += 3600
  fake.send(A.payer, X.x402Tx.finalizeWithdraw(SET, config))
  assert.equal(fake.channel(channelId).balance, 2n * PRICE, 'finalize is capped to balance − totalClaimed')
})

test('x402-batch loop: the SDK\'s session expiry (the contract has none): nothing is signed after it; a voucher signed before stays claimable', async () => {
  let t = NOW
  const { fake, payer, acc } = loop({ sessionExpiry: NOW + 60, clock: () => t })
  const l1 = await payer.reserve(svc, PRICE); const ok = await acc.verifyVoucher(l1.voucher, PRICE); await ok.commit(); await l1.commit()
  t = NOW + 61
  await assert.rejects(payer.reserve(svc, PRICE), (e) => e.code === 'BAD_VOUCHER' && e.data.reason === 'x402-session-expired')
  // the contract does not know the SDK's expiry: the provider can still claim the earlier voucher (X402-FORK-DRILL §6.2 item 3)
  fake.clock.t = NOW + 86400 * 365
  fake.send(A.receiver, acc.claimTx(await acc.claimRows()))
  assert.equal(fake.receiver(A.receiver, BEM).totalClaimed, PRICE)
  // the default session is short / 默认会话很短
  assert.equal(X.x402Payer({ chainId: 56, consumer: A.payer, sessionKey: PK.session, terms: TERMS, clock: () => NOW }).sessionExpiry, NOW + X.X402_DEFAULT_SESSION_S)
  assert.equal(X.X402_DEFAULT_SESSION_S, 3600)
})

test('x402-batch loop: the payer refuses a service whose delay is above its cap, or whose manifest names another settlement', async () => {
  const p = X.x402Payer({ chainId: 56, consumer: A.payer, sessionKey: PK.session, terms: { [A.receiver]: { ...TERMS[A.receiver], withdrawDelay: 7 * 86400 } }, clock: () => NOW })
  await assert.rejects(async () => p.reserve(svc, PRICE), (e) => e.data?.reason === 'x402-withdraw-delay-too-long')
  const q = X.x402Payer({ chainId: 56, consumer: A.payer, sessionKey: PK.session, terms: TERMS, clock: () => NOW })
  await assert.rejects(async () => q.reserve({ ...svc, manifest: { payment: { escrow: '0x' + 'e1'.repeat(20) } } }, PRICE), (e) => e.data?.reason === 'x402-settlement-mismatch')
  await assert.rejects(async () => q.reserve({ ...svc, manifest: { payment: { escrow: null } } }, PRICE), (e) => e.data?.reason === 'x402-settlement-mismatch')
  await assert.rejects(async () => q.reserve({ container: '0x' + '5f'.repeat(20) }, PRICE), (e) => e.data?.reason === 'x402-terms-missing')
})

test('x402-batch loop: a withdrawal by the session key returns funds to the payer only, after the service\'s delay, capped by what was claimed', async () => {
  const { fake, payer, acc, config, channelId } = loop({ deposit: 5n * PRICE })
  const l = await payer.reserve(svc, PRICE); const ok = await acc.verifyVoucher(l.voucher, PRICE); await ok.commit(); await l.commit()
  assert.throws(() => fake.send(A.relayer, X.x402Tx.initiateWithdraw(SET, config, 4n * PRICE)), (e) => e.reason === 'InvalidChannel')
  fake.send(A.session, X.x402Tx.initiateWithdraw(SET, config, 4n * PRICE))   // the key can start it (drill X6) / 钥匙可以发起
  // inside the window the provider claims what it charged; it is protected / 窗口内服务方 claim 已收费额
  fake.send(A.receiver, acc.claimTx(await acc.claimRows()))
  fake.clock.t += 3599
  assert.throws(() => fake.send(A.payer, X.x402Tx.finalizeWithdraw(SET, config)), (e) => e.reason === 'WithdrawDelayNotElapsed')
  fake.clock.t += 1
  const p0 = fake.balanceOf(A.payer), s0 = fake.balanceOf(A.session)
  fake.send(A.session, X.x402Tx.finalizeWithdraw(SET, config))
  assert.equal(fake.balanceOf(A.payer) - p0, 4n * PRICE, 'to config.payer')
  assert.equal(fake.balanceOf(A.session), s0, 'never to the key')
  assert.equal(fake.channel(channelId).balance, PRICE, 'what was claimed stays for the provider')
})

test('x402-batch fake: Permit2 refuses a replayed nonce, an expired deadline, a wrong signer, and a payer with code (a container\'s 1271 answers 0)', () => {
  const fake = createX402Fake({ token: BEM, now: NOW })
  fake.mint(A.payer, 10n ** 10n); fake.send(A.payer, X.x402Tx.approvePermit2(BEM))
  const id = X.x402ChannelId(56, SET, CFG_A)
  const dep = (key, nonce, deadline, cfg = CFG_A) => X.x402Tx.deposit(SET, cfg, { amount: PRICE, nonce, deadline, signature: signDigest(X.x402DepositDigest(56, { token: BEM, amount: PRICE, nonce, deadline, channelId: X.x402ChannelId(56, SET, cfg) }), key) })
  fake.send(A.relayer, dep(PK.payer, 0, NOW + 60))
  assert.throws(() => fake.send(A.relayer, dep(PK.payer, 0, NOW + 60)), (e) => e.reason === 'InvalidNonce')
  assert.throws(() => fake.send(A.relayer, dep(PK.payer, 1, NOW - 1)), (e) => e.reason === 'SignatureExpired')
  assert.throws(() => fake.send(A.relayer, dep(PK.session, 2, NOW + 60)), (e) => e.reason === 'InvalidSigner')
  fake.setCode(A.payer)
  assert.throws(() => fake.send(A.relayer, dep(PK.payer, 3, NOW + 60)), (e) => e.reason === 'InvalidContractSignature')
  assert.equal(fake.channel(id).balance, PRICE, 'a reverted call changed nothing')
  assert.ok(Revert)
})

// ---- the spend limiter and the budget around the x402 payer / 限额器与预算包在 x402 付款器外 ----
const MANDATE = agent.normalizeMandate({ principal: '0x86DDaEF00401E3F10418398D67D7189fc458eA95', agent: '0x' + 'a6'.repeat(20), agentKey: A.session, mode: 1, taskHash: '0x' + '12'.repeat(32), scope: [{ provider: A.receiver, token: BEM, cap: (3n * PRICE).toString() }], feeToken: '0x' + '00'.repeat(20), feeCap: '0', notBefore: NOW - 60, expires: NOW + 3600, nonce: '1', subdelegate: false })
const checkOf = (channelId, o = {}) => ({ ok: true, enforcement: 'x402-batch', phase: 1, mandate: MANDATE, mandateHash: '0x' + 'cd'.repeat(32), consumer: A.payer, problems: [], scope: [{ provider: A.receiver, escrow: SET, claimedAtCheck: '0', available: (10n * PRICE).toString(), channelId, ...o }] })

test('x402-batch + limiter: the record pins the channel id; the cap holds; a voucher on another channel stops the order', async () => {
  const { payer, acc, channelId } = loop()
  const lim = createSpendLimiter({ clock: () => NOW })
  await lim.accept({ chainId: 56, agentKey: A.session })
  const rec = await lim.start({ chainId: 56, check: checkOf(channelId) })
  assert.equal(rec.enforcement, 'x402-batch'); assert.equal(rec.providers[0].channelId, channelId)
  assert.deepEqual(spendRecord(JSON.parse(JSON.stringify(rec))), rec, 'the record round-trips as JSON')
  const lp = lim.payer({ chainId: 56, payer, maxPrice: PRICE })
  for (let i = 0; i < 3; i++) { const l = await lp.reserve(svc, PRICE); const ok = await acc.verifyVoucher(l.voucher, PRICE); await ok.commit(); await l.commit(); assert.equal(l.voucher.mandateHash, '0x' + 'cd'.repeat(32)) }
  await assert.rejects(lp.reserve(svc, PRICE), (e) => e.data?.reason === 'spend-cap-exceeded')
  // a recheck that reads another channel id for the provider stops it, as another escrow does / 读到另一通道 id 即停工
  const r = spendRecheck(rec, checkOf('0x' + '99'.repeat(32)))
  assert.deepEqual(r.stop, ['spend-escrow-changed'])
  const r2 = spendRecheck(rec, { ...checkOf(channelId), enforcement: 'escrow-channel' })
  assert.deepEqual(r2.problems, ['spend-not-enforced'], 'an escrow-channel check is not this record\'s backend')
})

test('x402-batch + limiter: a payer whose voucher names another channel than the pinned one is stopped (spend-voucher-mismatch)', async () => {
  const { payer } = loop()
  const other = X.x402Payer({ chainId: 56, consumer: A.payer, sessionKey: PK.session, terms: { [A.receiver]: { ...TERMS[A.receiver], salt: '0x' + '00'.repeat(31) + '07' } }, sessionExpiry: NOW + 600, clock: () => NOW })
  const lim = createSpendLimiter({ clock: () => NOW })
  await lim.accept({ chainId: 56, agentKey: A.session })
  await lim.start({ chainId: 56, check: checkOf(payer.channelOf(svc).channelId) })
  await assert.rejects(lim.payer({ chainId: 56, payer: other, maxPrice: PRICE }).reserve(svc, PRICE), (e) => e.data?.reason === 'spend-voucher-mismatch')
  assert.deepEqual((await lim.record({ chainId: 56, agentKey: A.session })).stopped.reasons, ['spend-voucher-mismatch'])
})

test('x402-batch + limiter + budget: the client budget (policy) admits each voucher as it does with escrow-channel', async () => {
  const { payer, channelId } = loop()
  const lim = createSpendLimiter({ clock: () => NOW })
  await lim.accept({ chainId: 56, agentKey: A.session })
  await lim.start({ chainId: 56, check: checkOf(channelId) })
  const budget = createBudget({ policy: { tapeapiPolicy: 1, rules: [{ name: 'x402 BEM', service: A.receiver, period: 'total', maxAmount: '0.015', currency: 'BEM' }] }, store: memoryBudgetStore() })
  const lp = lim.payer({ chainId: 56, payer, maxPrice: PRICE, budget, tokenDecimals: 8 })
  const l1 = await lp.reserve(svc, PRICE); await l1.commit()
  await assert.rejects(lp.reserve(svc, PRICE), (e) => e.code === 'BUDGET_EXCEEDED', 'the second 0.01 BEM is over the policy\'s 0.015')
  assert.equal(payer.inflightOf(svc), 0, 'the refused voucher was released')
})

// ---- the kit: verifyMandate(signed, { enforcement: 'x402-batch' }) at the pinned block / kit 的核验 ----
const HUB = '0x' + '10'.repeat(20)
const HOLDER = addrOf(KEYS.principalHolder), KEY = addrOf(KEYS.agentKey)
const signed = (m) => ({ mandate: m, sig: agent.signMandate(56, HUB, m, KEYS.principalHolder, { allowFunds: true }) })
function kitWorld({ holderCode = false, delay = 3600, unclaimed = 100n, claimed = 0n } = {}) {
  const x = standardWorld()
  nameEscrow(x, S, SET)
  x.chain.setCode(SET, true)
  if (holderCode) x.chain.setCode(HOLDER, true)
  const terms = { [S]: { receiverAuthorizer: A.receiverAuth, token: BEM_TOKEN, withdrawDelay: delay } }
  const id = X.x402ChannelId(56, SET, { payer: HOLDER, payerAuthorizer: KEY, receiver: S, receiverAuthorizer: A.receiverAuth, token: BEM_TOKEN, withdrawDelay: Math.min(delay, 2592000) })
  // both nodes answer the settlement's views: channels(id) = (balance, totalClaimed), no pending withdrawal
  // 两个节点都回答结算合约的视图
  const word = (n) => BigInt(n).toString(16).padStart(64, '0')
  const answer = (data) => (data.slice(0, 10) === selector('channels(bytes32)') && data.slice(10, 74).toLowerCase() === id.slice(2) ? '0x' + word(unclaimed + claimed) + word(claimed) : '0x' + word(0) + word(0))
  for (const url of RPC) x.lie(url, (method, params, honest) => (method === 'eth_call' && eqAddr(params[0].to, SET) ? answer(params[0].data) : honest))
  const kit = agent.createAgentKit(x.api(), { clock: () => NOW })
  return { x, kit, terms, id }
}
const fundedMandate = () => mandateOf({ mode: 1, notBefore: NOW - 60, expires: NOW + 3600, scope: [{ provider: S, token: BEM_TOKEN, cap: '100' }] })

test('x402-batch kit: verifyMandate reads the x402 channel at the pinned block; ok with enforcement x402-batch and a reading the limiter pins', async () => {
  const { kit, terms, id } = kitWorld()
  const r = await kit.verifyMandate(signed(fundedMandate()), { enforcement: 'x402-batch', x402: { terms } })
  assert.deepEqual(r.problems.map((p) => p.code), [], JSON.stringify(r.problems))
  assert.equal(r.ok, true); assert.equal(r.enforcement, 'x402-batch'); assert.equal(r.phase, 1); assert.equal(r.consumer, HOLDER)
  assert.equal(r.scope[0].escrow, SET); assert.equal(r.scope[0].channelId, id); assert.equal(r.scope[0].claimedAtCheck, '0'); assert.equal(r.scope[0].available, '100'); assert.equal(r.scope[0].decimals, 8)
  const rec = createSpendLimiter({ clock: () => NOW })
  await rec.accept({ chainId: 56, agentKey: KEY })
  assert.equal((await rec.start({ chainId: 56, check: r })).providers[0].channelId, id)
})

test('x402-batch kit: the container path and a holder with code are x402-payer-not-eoa; a delay above the cap, missing terms, a channel above the cap are refused', async () => {
  const codes = (r) => r.problems.map((p) => p.code)
  const m = fundedMandate()
  const a = kitWorld()
  assert.deepEqual(codes(await a.kit.verifyMandate(signed(m), { enforcement: 'x402-batch', x402: { terms: a.terms }, fundingPath: 'container' })), ['x402-payer-not-eoa'])
  const b = kitWorld({ holderCode: true })
  const rb = await b.kit.verifyMandate(signed(m), { enforcement: 'x402-batch', x402: { terms: b.terms } })
  assert.deepEqual(codes(rb), ['x402-payer-not-eoa']); assert.match(rb.problems[0].message, /isValidSignature/)
  assert.equal(rb.enforcement, 'none')
  const c = kitWorld({ delay: 7 * 86400 })
  assert.deepEqual(codes(await c.kit.verifyMandate(signed(m), { enforcement: 'x402-batch', x402: { terms: c.terms } })), ['x402-withdraw-delay-too-long'])
  assert.deepEqual(codes(await c.kit.verifyMandate(signed(m), { enforcement: 'x402-batch', x402: { terms: c.terms, maxWithdrawDelayS: 7 * 86400 } })), [], 'a cap the caller raises')
  assert.deepEqual(codes(await a.kit.verifyMandate(signed(m), { enforcement: 'x402-batch' })), ['x402-terms-missing'])
  const d = kitWorld({ unclaimed: 101n })
  assert.deepEqual(codes(await d.kit.verifyMandate(signed(m), { enforcement: 'x402-batch', x402: { terms: d.terms } })), ['channel-exceeds-cap'])
  const e = kitWorld({ unclaimed: 0n })
  assert.deepEqual(codes(await e.kit.verifyMandate(signed(m), { enforcement: 'x402-batch', x402: { terms: e.terms } })), ['channel-empty'])
})

test('x402-batch kit: verifyTaskThread with enforcement x402-batch carries the applied mandate\'s x402 check and readings', async () => {
  const { kit, terms, id } = kitWorld()
  const t = happyThread({ m: fundedMandate() })
  const r = await kit.verifyTaskThread(t.messages, { enforcement: 'x402-batch', x402: { terms } })
  assert.deepEqual(r.problems.map((p) => p.code), [], JSON.stringify(r.problems))
  assert.equal(r.enforcement, 'x402-batch'); assert.equal(r.phase, 1); assert.equal(r.mandateCheck.enforcement, 'x402-batch')
  assert.equal(r.scope[0].channelId, id); assert.equal(r.consumer, HOLDER)
  const bad = await kitWorld({ holderCode: true }).kit.verifyTaskThread(t.messages, { enforcement: 'x402-batch', x402: { terms } })
  assert.equal(bad.enforcement, 'none'); assert.ok(bad.problems.some((p) => p.code === 'x402-payer-not-eoa'))
})
