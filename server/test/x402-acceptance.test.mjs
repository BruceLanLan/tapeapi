// @experimental prototype: createProvider({ enforcement: x402Acceptance(...) }) takes x402 batch-settlement vouchers on
// a fake settlement contract (sdk/test/helpers/x402-fake.mjs); without the option the TAPI-22 path is unchanged (the
// golden test, payment-golden.test.mjs). Keys are anvil's public test keys; no network.
// 实验原型：服务方接受 x402 批量结算凭证；不给该选项时 TAPI-22 路径不变。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createProvider } from '../src/index.js'
import { sig } from '@tapeapi/sdk'
import * as agent from '@tapeapi/sdk/agent'
import { createX402Fake } from '../../sdk/test/helpers/x402-fake.mjs'
import { ADDR } from '../../sdk/test/helpers/fake-chain.mjs'

const { privateKeyToAddress, signDigest, delegationDigest } = sig
const SIGNER_KEY = '0x' + '22'.repeat(32), HOLDER_KEY = '0x' + '11'.repeat(32)
const PAYER_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'
const SESSION_KEY = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a'
const RA = privateKeyToAddress('0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a')
const BEM = '0x5ce033B2bFCa3Af30b3e8C8457DeaF776A8b695a'
const signer = privateKeyToAddress(SIGNER_KEY)
const nowS = () => Math.floor(Date.now() / 1000)
const PRICE = 10000n   // 0.0001 BEM
const manifestFor = (escrow = agent.X402_SETTLEMENT) => {
  const expires = nowS() + 300 * 86400
  return {
    tapeapi: '0.1', name: 'x402', circuits: ADDR.circuits, tokenId: '4246', container: ADDR.container, signer,
    delegation: { expires, sig: signDigest(delegationDigest(56, ADDR.hub, { container: ADDR.container, signer, expires }), HOLDER_KEY) },
    endpoints: { live: ['http://127.0.0.1/tapeapi/v1'], async: false },
    methods: [{ name: 'paid', priceBEM: '0.0001', params: {}, returns: {} }],
    payment: { escrow, unit: 'BEM', decimals: 8 },
  }
}
function setup({ escrow } = {}) {
  const fake = createX402Fake({ token: BEM, now: nowS() })
  const acc = agent.x402Acceptance({ chainId: 56, container: ADDR.container, receiverAuthorizer: RA, token: BEM, withdrawDelay: 3600, read: fake.read })
  const p = createProvider({ manifest: manifestFor(escrow), signerKey: SIGNER_KEY, chainId: 56, allowHttp: true, allowMemoryStore: true, log: () => {}, enforcement: acc, methods: { paid: async (params, ctx) => ({ payer: ctx.consumer, cumulative: String(ctx.cumulative) }) } })
  const payerAddr = privateKeyToAddress(PAYER_KEY)
  const payer = agent.x402Payer({ chainId: 56, consumer: payerAddr, sessionKey: SESSION_KEY, terms: { [ADDR.container]: acc.terms() } })
  const svc = { container: ADDR.container, manifest: { payment: { escrow: agent.X402_SETTLEMENT } } }
  const { config, channelId } = payer.channelOf(svc)
  fake.mint(payerAddr, 10n ** 8n); fake.send(payerAddr, agent.x402Tx.approvePermit2(BEM))
  const deadline = nowS() + 600, amount = 3n * PRICE
  fake.send(payerAddr, agent.x402Tx.deposit(agent.X402_SETTLEMENT, config, { amount, nonce: 0, deadline, signature: signDigest(agent.x402DepositDigest(56, { token: BEM, amount, nonce: 0, deadline, channelId }), PAYER_KEY) }))
  return { fake, acc, p, payer, svc, payerAddr }
}

test('x402 acceptance: a priced call with an x402 voucher is served and billed; the provider claims what it charged', async () => {
  const { fake, acc, p, payer, svc, payerAddr } = setup()
  for (let i = 1n; i <= 2n; i++) {
    const lease = await payer.reserve(svc, PRICE)
    const out = await p.invoke({ id: `c${i}`, method: 'paid', params: {}, voucher: lease.voucher }, { ip: '10.0.0.1' })
    assert.equal(out.status, 200, JSON.stringify(out.env ?? out))
    assert.equal(out.env.result.payer, payerAddr); assert.equal(out.env.result.cumulative, String(i * PRICE))
    await lease.commit()
  }
  const rows = await acc.claimRows()
  assert.equal(rows[0].totalClaimed, String(2n * PRICE))
  fake.send(ADDR.container, acc.claimTx(rows)); fake.send(ADDR.container, acc.settleTx())
  assert.equal(fake.balanceOf(ADDR.container), 2n * PRICE)
})

test('x402 acceptance: a TAPI-22 voucher, a voucher over the channel and a replay are BAD_VOUCHER; the boot refuses a manifest naming another escrow', async () => {
  const { p, payer, svc } = setup()
  const tapi22 = { consumer: '0x' + '33'.repeat(20), provider: ADDR.container, cumulative: '10000', expires: nowS() + 3600, sig: '0x' + '00'.repeat(65) }
  const a = await p.invoke({ id: 'a', method: 'paid', params: {}, voucher: tapi22 }, { ip: '10.0.0.2' })
  assert.equal(a.env?.error?.code ?? a.unsigned?.error?.code, 'BAD_VOUCHER')
  const l1 = await payer.reserve(svc, PRICE)
  assert.equal((await p.invoke({ id: 'b', method: 'paid', params: {}, voucher: l1.voucher }, { ip: '10.0.0.2' })).status, 200)
  await l1.commit()
  const replay = await p.invoke({ id: 'c', method: 'paid', params: {}, voucher: l1.voucher }, { ip: '10.0.0.2' })
  assert.equal(replay.env.error.code, 'BAD_VOUCHER'); assert.equal(replay.env.error.data.reason, 'stale')
  // a voucher whose ceiling is above the price is charged the price only (claim ≤ ceiling); the ceiling is what the key
  // signed, and what the limiter counts / 上限高于价格的凭证只按价格收费；上限是钥匙签出的额度，限额器按它计
  const big = await payer.reserve(svc, 5n * PRICE)
  const d = await p.invoke({ id: 'd', method: 'paid', params: {}, voucher: big.voucher }, { ip: '10.0.0.2' })
  assert.equal(d.status, 200); assert.equal(d.env.result.cumulative, String(2n * PRICE))
  await big.commit()
  const l3 = await payer.reserve(svc, PRICE)
  assert.equal((await p.invoke({ id: 'e', method: 'paid', params: {}, voucher: l3.voucher }, { ip: '10.0.0.2' })).status, 200)
  await l3.commit()
  const l4 = await payer.reserve(svc, PRICE)
  assert.equal((await p.invoke({ id: 'f', method: 'paid', params: {}, voucher: l4.voucher }, { ip: '10.0.0.2' })).env.error.data.reason, 'funds', 'the channel holds 3 × PRICE')
  l4.release()
  assert.throws(() => setup({ escrow: '0x' + 'e1'.repeat(20) }), (e) => e.code === 'INVALID_ARGUMENT' && /payment\.escrow must name it/.test(e.message))
  assert.equal((await p.checkEscrowToken()).status, 'skipped')
})
