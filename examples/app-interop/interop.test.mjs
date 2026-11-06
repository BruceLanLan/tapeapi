// examples/app-interop: app A calls app B, on the SDK's fake chain (nothing leaves this process). One test per thing the
// example shows: discovery, a free call anyone can make, a receipt anyone can check, a priced call within the user's cap,
// the cap, expiry, the absence of a revoke, what B can and cannot tell about its caller, and the visitor grant
// (@tapeapi/interop, experimental). The escrow is a model
// of an unaudited, undeployed contract: this is local only.
// 示例测试：A 调用 B，全在假链上。每条现象一个测试。托管是未审计、未部署合约的模型：只在本地。
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { sig } from '@tapeapi/sdk'
import { createAgentKit } from '@tapeapi/sdk/agent'
import { createInteropWorld, restoreTime, APP_A, APP_B, USER, USER_KEY, PRICE, B_ORIGIN, ESCROW, HUB } from './world.mjs'
import { grantReasonOf, grantDigest } from '@tapeapi/interop'
import { discover, checkReceipt, callChecked, planGrant, payerFor, askVisitorGrant, signedGrant } from './app-a.mjs'
import { runDemo } from './demo.mjs'
import { mandateOf, mandateMsg, addrOf, KEYS, P } from '../../sdk/test/helpers/agent-chain.mjs'

afterEach(restoreTime)
const H = 3600, D48 = 48 * H

async function setup({ cap = 3n * PRICE + PRICE / 2n, life = H } = {}) {
  const w = createInteropWorld()
  const api = w.apiA()
  const { svc, methods } = await discover(api, APP_B.name)
  const grant = async () => {
    const g = await planGrant(w.walletApi(), svc, { cap, expires: w.clock() + life })
    for (const tx of g.txs) w.wallet.send(tx)
    return g
  }
  return { w, api, svc, methods, grant }
}
const lower = (a) => a.toLowerCase()
// does anything B received name app A? (its container address, in any case) / B 收到的东西里有没有 A
const namesA = (w) => w.toB.some((r) => lower(JSON.stringify(r)).includes(lower(APP_A.container).slice(2)))

test('discovery: A finds B by name and reads B\'s manifest from B\'s own site on the chain (delegation checked); the methods and prices are there', async () => {
  const { w, svc, methods } = await setup()
  assert.equal(lower(svc.container), lower(APP_B.container))
  assert.deepEqual(svc.verified, { delegation: true, holder: addrOf(KEYS.providerHolder) })
  assert.deepEqual(methods, [{ name: 'profile', priceBEM: '0' }, { name: 'quote', priceBEM: '0.0001' }, { name: 'history', priceBEM: '0', grant: 'required' }, { name: 'grant_revoke', priceBEM: '0' }])
  assert.equal(svc.manifest.payment.escrow, ESCROW)
  // the manifest is a file of B's site (same container), not something B's endpoint said / 清单是 B 站点里的文件
  assert.ok(w.x.chain.state.files.has(`${lower(APP_B.container)}:.well-known/tapeapi.json`))
  assert.ok(!w.requests.some((u) => u.startsWith(B_ORIGIN)), 'resolving asks B\'s endpoint nothing')
})

test('free call: anonymous, signed by B\'s delegated key; A re-checks the receipt independently; B sees no caller at all', async () => {
  const { w, api, svc } = await setup()
  const r = await callChecked(api, svc, 'profile', {})
  assert.equal(r.raw.verified, true)
  assert.equal(r.result.profile.name, 'App B')
  assert.equal(lower(r.receipt.signer), lower(svc.manifest.signer))
  // anyone with (container, id, method, params, result, ts, sig) recovers the same signer / 任何人都能复核
  assert.equal(lower(sig.recoverResponseSigner({ container: svc.container, id: r.raw.id, method: 'profile', params: {}, ok: true, body: r.result, ts: r.raw.ts }, r.raw.sig)), lower(svc.manifest.signer))
  assert.deepEqual(w.appB.seen, [{ method: 'profile', consumer: null, voucherSigner: null, paramKeys: [] }])
  assert.equal(r.result.caller, null)
  assert.equal(namesA(w), false, 'nothing B received names app A')
})

test('receipt: one changed byte in B\'s answer is BAD_SIGNATURE; a receipt checked against other params does not hold; a lapsed delegation is refused at resolve', async () => {
  const { w, api, svc } = await setup()
  w.setTamper(async (_u, text) => text.replace('App B', 'App X'))
  await assert.rejects(api.call(svc, 'profile', {}), (e) => e.code === 'BAD_SIGNATURE')
  w.setTamper(null)
  const r = await api.call(svc, 'profile', {})
  assert.equal(checkReceipt(svc, 'profile', {}, r).ok, true)
  assert.equal(checkReceipt(svc, 'profile', { other: 1 }, r).ok, false, 'the signature covers the params A sent')
  // B's holder delegated its signer for 30 days; after that nobody may rely on B's answers / 委托 30 天后过期
  w.advance(31 * 86400)
  await assert.rejects(w.apiA().resolve(APP_B.name), (e) => e.code === 'DELEGATION_INVALID')
})

test('priced call without a grant: PAYMENT_REQUIRED; and the SDK will not even build approve/fund for an escrow it was not told to allow (none is audited)', async () => {
  const { w, api, svc } = await setup()
  await assert.rejects(api.call(svc, 'quote', {}), (e) => e.code === 'PAYMENT_REQUIRED')
  await assert.rejects(api.tx.approve({ amount: PRICE, spender: svc }), (e) => e.data?.reason === 'escrow-not-allowed')
  assert.equal(w.appB.seen.length, 0, 'B\'s handler never ran')
})

test('grant within the cap: the user funds the channel (U -> B) and authorizes A\'s key; three paid calls succeed with receipts; B sees the user and A\'s key, never A', async () => {
  const { w, api, svc, grant } = await setup()
  const g = await grant()
  assert.equal(w.escrow.channelOf(USER, APP_B.container), 3n * PRICE + PRICE / 2n)
  assert.equal(w.escrow.sessionOf(USER, APP_B.container, g.key), BigInt(g.expires))
  const payer = payerFor(api, g, { user: USER })
  for (let i = 0; i < 3; i++) {
    const r = await callChecked(api, svc, 'quote', { pair: 'BEM/USD' }, { payer })
    assert.equal(r.receipt.ok, true)
    assert.equal(lower(r.result.paidBy), lower(USER))
    assert.equal(lower(r.result.key), lower(g.key))
  }
  assert.equal(payer.cumulativeOf(svc), 3n * PRICE)
  assert.deepEqual(w.appB.seen.map((s) => [s.method, lower(s.consumer), lower(s.voucherSigner)]), Array(3).fill(['quote', lower(USER), lower(g.key)]))
  assert.equal(namesA(w), false, 'B knows which user paid and which key signed, not that the key is app A\'s')
})

test('the cap: with a cap of 3.5 prices the 4th call is refused by B (not only by A) and charges nothing; B settles exactly 3 prices; the user gets the rest back after 48 h', async () => {
  const { w, api, svc, grant } = await setup()
  const before = w.escrow.balanceOf(USER)
  const g = await grant()
  const payer = payerFor(api, g, { user: USER })
  for (let i = 0; i < 3; i++) await callChecked(api, svc, 'quote', {}, { payer })
  await assert.rejects(api.call(svc, 'quote', {}, { payer }), (e) => e.code === 'BAD_VOUCHER' && /exceeds the available channel/.test(e.message))
  assert.equal(w.appB.seen.length, 3, 'B\'s handler did not run for the refused call')
  assert.equal(payer.cumulativeOf(svc), 3n * PRICE)
  assert.deepEqual(await w.settleAll(), ['settle'])
  assert.equal(w.escrow.claimedOf(USER, APP_B.container), 3n * PRICE)
  // close-out: requestWithdraw what is left, wait out the 48 h cooldown, withdraw / 收尾取回
  const wa = w.walletApi()
  w.wallet.send(wa.tx.requestWithdraw(svc, w.escrow.channelOf(USER, APP_B.container)))
  assert.throws(() => w.wallet.send(wa.tx.withdraw(svc)), (e) => e.revert === 'CooldownActive')
  w.advance(D48)
  w.wallet.send(wa.tx.withdraw(svc))
  assert.equal(w.escrow.balanceOf(USER), before - 3n * PRICE, 'the user paid exactly the three answered calls')
})

test('expiry: once A\'s session lapses, A\'s payer refuses locally, and B refuses a voucher from a payer that does not check (B enforces it, not A\'s honesty)', async () => {
  const { w, api, svc, grant } = await setup({ life: H })
  const g = await grant()
  await callChecked(api, svc, 'quote', {}, { payer: payerFor(api, g, { user: USER }) })
  w.advance(H + 1)
  await assert.rejects(api.call(svc, 'quote', {}, { payer: payerFor(api, g, { user: USER }) }), (e) => e.code === 'BAD_VOUCHER' && /expired/.test(e.message))
  const careless = payerFor(api, g, { user: USER, checkLocally: false })
  careless.setCumulative(svc, PRICE)
  await assert.rejects(api.call(svc, 'quote', {}, { payer: careless }), (e) => e.code === 'BAD_VOUCHER' && /not authorised or expired/.test(e.message))
  assert.equal(w.appB.seen.length, 1)
})

test('no instant revoke: a session cannot be shortened; the user\'s only lever is a withdraw request, which stops B while the key stays authorised, and cancelling it restores A at once', async () => {
  const { w, api, svc, grant } = await setup({ life: 10 * H })
  const g = await grant()
  const wa = w.walletApi()
  const payer = payerFor(api, g, { user: USER })
  await callChecked(api, svc, 'quote', {}, { payer })
  // "revoke" by shortening the session to now + 1 s: the escrow refuses (extend-only) / 缩短会话：合约拒绝
  assert.throws(() => w.wallet.send(wa.tx.authorizeSession(svc, g.key, w.clock() + 1)), (e) => e.revert === 'SessionShorteningNotSupported')
  w.wallet.send(wa.tx.requestWithdraw(svc, w.escrow.channelOf(USER, APP_B.container)))
  await assert.rejects(api.call(svc, 'quote', {}, { payer }), (e) => e.code === 'BAD_VOUCHER' && /available channel 0/.test(e.message))
  assert.ok(w.escrow.sessionOf(USER, APP_B.container, g.key) > BigInt(w.clock()), 'the key is still authorised on chain: this is not a revocation')
  w.wallet.send(wa.tx.cancelWithdraw(svc))
  assert.equal((await callChecked(api, svc, 'quote', {}, { payer })).receipt.ok, true)
})

// The visitor grant (@tapeapi/interop, experimental). The many refusals are in interop-grant.test.mjs; these two
// keep the main phenomena: B names A in its signed answer, the
// receipt covers it, and a bad grant is refused before B's handler runs, charging nothing.
// 访客授权。逐项拒绝在 interop-grant.test.mjs；这里保留两条主要现象。
test('visitor grant: the visitor signs "A may call B\'s history"; A sends it with a call proof; B checks it and names A in its signed answer; the receipt covers the grant record', async () => {
  const { w, api, svc } = await setup()
  const ask = await askVisitorGrant(w.chainA(), { svc, appA: APP_A, appB: APP_B, user: USER, methods: ['history'], maxCalls: 5, now: w.clock(), hub: HUB })
  assert.match(ask.payload.message.statement, /^Allow 12\.7\.tape to call these methods of 13\.7\.tape on my behalf: history\. At most 5 calls/)
  const g = signedGrant(ask, w.wallet.signTypedData(ask.payload))
  const r = await w.grants.call(api, svc, 'history', {}, g)
  assert.equal(r.verified, true)
  assert.equal(lower(r.result.caller.app), lower(APP_A.container))
  assert.equal(r.result.caller.name, APP_A.name)
  assert.equal(lower(r.result.visitor), lower(USER))
  assert.deepEqual(r.grant, { hash: ask.hash, used: 1, maxCalls: 5 })
  // the grant record is part of what B signed: anyone recovers B's signer over it, and drops it at their peril
  // 授权记录在 B 的签名之内：去掉它，回执就不成立
  assert.equal(checkReceipt(svc, 'history', {}, r).ok, true)
  const { grant: _g, ...without } = r.result
  assert.equal(checkReceipt(svc, 'history', {}, { ...r, result: without }).ok, false)
  assert.equal(namesA(w), true, 'now B received something naming A: the grant')
})

test('visitor grant: B refuses a forged grant, a method outside it (a priced one with a voucher included) and an expired one, before its handler runs and charging nothing (BAD_REQUEST, "grant: <reason>", no error.data)', async () => {
  const { w, api, svc, grant } = await setup()
  const g = await grant()
  const payer = payerFor(api, g, { user: USER })
  const ask = await askVisitorGrant(w.chainA(), { svc, appA: APP_A, appB: APP_B, user: USER, methods: ['history'], maxCalls: 5, now: w.clock(), hub: HUB })
  const good = signedGrant(ask, w.wallet.signTypedData(ask.payload))
  const refused = async (p, reason, method = 'history', opts = {}) => {
    const id = 'x-' + reason + '-' + method
    w.grants.attach(id, svc, good)
    try {
      await assert.rejects(api.call(svc, method, p, { ...opts, id }), (e) => e.code === 'BAD_REQUEST' && grantReasonOf(e) === reason && e.data === undefined)
    } finally { w.grants.detach(id) }
  }
  // forged: the wallet did not sign this / 伪造
  const forged = { ...good, userSig: sig.signDigest(grantDigest(56, HUB, good.message), KEYS.stranger) }
  const id1 = 'x-forged'; w.grants.attach(id1, svc, forged)
  await assert.rejects(api.call(svc, 'history', {}, { id: id1 }), (e) => grantReasonOf(e) === 'bad-user-signature')
  // out of scope: profile is not in the grant (and takes none) / 方法越界
  await refused({}, 'method-out-of-scope', 'profile')
  // a priced method with a voucher: not in the grant, and no priced method takes one / 收费方法带凭证：不在授权内
  await refused({}, 'method-out-of-scope', 'quote', { payer })
  assert.equal(payer.cumulativeOf(svc), 0n, 'the refused priced call charged nothing')
  assert.deepEqual(await w.provider.pendingSettlements(), [])
  // expired / 过期
  w.advance(H + 1)
  await refused({}, 'expired')
  assert.equal(w.appB.seen.length, 0, 'B\'s handler never ran')
})

test('what is not there: a mandate needs a container as principal, so a plain wallet cannot grant one (not-tapeout); a container\'s phase-0 mandate verifies but enforces nothing', async () => {
  const w = createInteropWorld()
  const kit = createAgentKit(w.apiA(), { clock: w.clock })
  const agentKey = addrOf(KEYS.agentKey)
  const scope = [{ provider: APP_B.container, token: '0x' + '00'.repeat(20), cap: '0' }]
  const byWallet = await kit.verifyMandate(mandateMsg(mandateOf({ principal: USER, agent: APP_A.container, agentKey, scope }), USER_KEY), { agentKey, agent: APP_A.container })
  assert.equal(byWallet.ok, false)
  assert.deepEqual(byWallet.problems.map((p) => p.code), ['not-tapeout'])
  const byContainer = await kit.verifyMandate(mandateMsg(mandateOf({ principal: P, agent: APP_A.container, agentKey, scope }), KEYS.principalHolder), { agentKey, agent: APP_A.container })
  assert.equal(byContainer.ok, true)
  assert.equal(byContainer.enforcement, 'none')
  // the funded, enforced form (phase 1: escrow channel + spend limiter) is exercised end to end by
  // examples/agent-service/agent-service-spend.test.mjs (P1M4-E01, E02), on the same kind of fake chain
})

test('offline: every request went to the fake chain\'s nodes or to B\'s in-process endpoint; the demo script runs the whole story', async () => {
  const lines = []
  const out = await runDemo({ log: (s) => lines.push(s) })
  assert.equal(out.ok, true)
  assert.ok(lines.length > 5)
  assert.deepEqual([...new Set(out.requests.map((u) => new URL(u).origin))].sort(), ['http://rpc1', 'http://rpc2', B_ORIGIN].sort())
})
