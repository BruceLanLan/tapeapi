// Container agents, phase 1 (experimental): the provider at level L0 is the reference provider exactly as it ships, with no option added. These tests pin
// what the draft says an L0 provider does with an agent key's vouchers, on the SDK's fake chain:
//   - it ignores an unsigned `mandate` / `mandateHash` member in the voucher and at the top level of the request (3 cases from a
//     review of the phase-1 design: CONFIRMED P1RV-S1 to S3);
//   - a full requestWithdraw stops it (available = channel − live request = 0), cancelWithdraw restarts it at once, and a
//     request past 48 h + 7 d no longer counts, so it serves again (TAPI-22 §3.2).
// Nothing here changes @tapeapi/server: the same behaviour is what every provider already has.
// 阶段 1（实验性）：L0 provider 就是原样发布的参考服务端，不加任何选项。这里钉住设计稿对 L0 的说法：忽略凭证里与请求顶层的不签名成员
// （阶段 1 设计审查留下的 3 个用例）；全额提现请求让它停服，cancelWithdraw 立即恢复，过了 48 小时 + 7 天的请求不再算数、重新服务。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createProvider } from '../src/index.js'
import { sig, parseUnits } from '@tapeapi/sdk'
import { createFakeChain, ADDR } from '../../sdk/test/helpers/fake-chain.mjs'

const { privateKeyToAddress, signDigest, voucherDigest, delegationDigest } = sig
const SIGNER_KEY = '0x' + '22'.repeat(32), CONSUMER_KEY = '0x' + '33'.repeat(32), SESSION_KEY = '0x' + '44'.repeat(32), HOLDER_KEY = '0x' + '11'.repeat(32)
const signer = privateKeyToAddress(SIGNER_KEY), consumer = privateKeyToAddress(CONSUMER_KEY), sessionAddr = privateKeyToAddress(SESSION_KEY)
const PRICE = parseUnits('0.0001')
const nowS = () => Math.floor(Date.now() / 1000)
const COOLDOWN_S = 48 * 3600, WINDOW_S = 7 * 86400
const voucher = (cumulative, key = SESSION_KEY, expires = nowS() + 3600) => {
  const v = { consumer, provider: ADDR.container, cumulative: cumulative.toString(), expires }
  return { ...v, sig: signDigest(voucherDigest(56, ADDR.escrow, v), key), signer: privateKeyToAddress(key) }
}

function mkProvider(chain) {
  const expires = nowS() + 300 * 86400
  const manifest = {
    tapeapi: '0.1', name: 'T', circuits: ADDR.circuits, tokenId: '4246', container: ADDR.container, signer,
    delegation: { expires, sig: signDigest(delegationDigest(56, ADDR.hub, { container: ADDR.container, signer, expires }), HOLDER_KEY) },
    endpoints: { live: ['http://127.0.0.1/tapeapi/v1'], async: false },
    methods: [{ name: 'paid', priceBEM: '0.0001', params: {}, returns: {} }],
    payment: { escrow: ADDR.escrow, unit: 'BEM', decimals: 8 },
  }
  return createProvider({
    minVoucherLifeS: 0, manifest, signerKey: SIGNER_KEY, rpcUrls: ['http://rpc1', 'http://rpc2'], quorum: 2, chainId: 56,
    fetch: chain.fetch, escrowCacheMs: 0, allowHttp: true, allowMemoryStore: true, log: () => {},
    methods: { paid: async (_p, ctx) => ({ consumer: ctx.consumer, signer: ctx.voucherSigner }) },
  })
}
function funded() {
  const chain = createFakeChain()
  chain.setChannel(consumer, ADDR.container, PRICE * 10n)
  chain.setSession(consumer, ADDR.container, sessionAddr, nowS() + 7 * 86400)
  return chain
}

test('CONFIRMED P1RV-S1: a voucher with an unsigned `mandate` / `mandateHash` member is accepted unchanged (unknown members ignored)', async () => {
  const chain = funded()
  const p = mkProvider(chain)
  const v = { ...voucher(PRICE), mandate: { mandate: { principal: consumer, agentKey: sessionAddr, scope: [] }, sig: '0x' + '11'.repeat(65) }, mandateHash: '0x' + 'ab'.repeat(32), somethingElse: 42 }
  const r = await p.invoke({ id: 'm1', method: 'paid', params: {}, voucher: v })
  assert.equal(r.status, 200, JSON.stringify(r.env?.error))
  assert.equal(r.env.ok, true)
  assert.equal(r.env.result.signer.toLowerCase(), sessionAddr.toLowerCase())
  // a second voucher with the extra member, higher cumulative: the stored record does not choke on it
  const r2 = await p.invoke({ id: 'm2', method: 'paid', params: {}, voucher: { ...voucher(2n * PRICE), mandateHash: '0x' + 'ab'.repeat(32) } })
  assert.equal(r2.env.ok, true, JSON.stringify(r2.env?.error))
})

test('CONFIRMED P1RV-S2: an unknown TOP-LEVEL request member (`mandate` beside `voucher`) is ignored too', async () => {
  const p = mkProvider(funded())
  const r = await p.invoke({ id: 't1', method: 'paid', params: {}, voucher: voucher(PRICE), mandate: { anything: true } })
  assert.equal(r.env.ok, true, JSON.stringify(r.env?.error))
})

test('CONFIRMED P1RV-S3: a very large unknown member is bounded only by the body limit (64 KiB default), not refused by shape', async () => {
  const p = mkProvider(funded())
  const r = await p.invoke({ id: 'big', method: 'paid', params: {}, voucher: { ...voucher(PRICE), mandate: 'x'.repeat(50_000) } })
  assert.equal(r.env.ok, true, JSON.stringify(r.env?.error))
})

test('CONFIRMED P1M4-L0-1: a full requestWithdraw stops the L0 provider; cancelWithdraw restarts it at once (draft §2.6 rows 3 and 4)', async () => {
  const chain = funded()
  const p = mkProvider(chain)
  assert.equal((await p.invoke({ id: 'a', method: 'paid', params: {}, voucher: voucher(PRICE) })).env.ok, true)
  // the principal's "revoke button": a request for the whole channel; the key's voucher is still valid on chain (§2.6)
  chain.setPendingWithdraw(consumer, ADDR.container, PRICE * 10n, nowS())
  const stopped = await p.invoke({ id: 'b', method: 'paid', params: {}, voucher: voucher(2n * PRICE) })
  assert.equal(stopped.env.ok, false)
  assert.equal(stopped.env.error.code, 'BAD_VOUCHER')
  assert.match(stopped.env.error.message, /exceeds the available channel 0/)
  // cancelWithdraw has no delay: the view is cleared, and the very next voucher is served
  chain.setPendingWithdraw(consumer, ADDR.container, 0n, 0n)
  const again = await p.invoke({ id: 'c', method: 'paid', params: {}, voucher: voucher(2n * PRICE) })
  assert.equal(again.env.ok, true, JSON.stringify(again.env?.error))
})

test('CONFIRMED P1M4-L0-2: a request past 48 h + 7 d is no longer live although the view still shows it: the L0 provider serves again (R21)', async () => {
  const chain = funded()
  const p = mkProvider(chain)
  // inside its lifetime (the last second of the window): stopped
  chain.setPendingWithdraw(consumer, ADDR.container, PRICE * 10n, nowS() - COOLDOWN_S - WINDOW_S + 5)
  const live = await p.invoke({ id: 'a', method: 'paid', params: {}, voucher: voucher(PRICE) })
  assert.equal(live.env.ok, false)
  assert.equal(live.env.error.code, 'BAD_VOUCHER')
  // lapsed: the escrow never clears it, the view returns it, yet withdraw can no longer run, so the money is exposed again
  chain.setPendingWithdraw(consumer, ADDR.container, PRICE * 10n, nowS() - COOLDOWN_S - WINDOW_S - 5)
  const lapsed = await p.invoke({ id: 'b', method: 'paid', params: {}, voucher: voucher(PRICE) })
  assert.equal(lapsed.env.ok, true, JSON.stringify(lapsed.env?.error))
})

test('CONFIRMED P1M4-L0-3: a partial live request leaves the rest available: the key is served up to channel − request, not beyond', async () => {
  const chain = funded()
  const p = mkProvider(chain)
  chain.setPendingWithdraw(consumer, ADDR.container, PRICE * 8n, nowS())
  assert.equal((await p.invoke({ id: 'a', method: 'paid', params: {}, voucher: voucher(2n * PRICE) })).env.ok, true)
  const over = await p.invoke({ id: 'b', method: 'paid', params: {}, voucher: voucher(3n * PRICE) })
  assert.equal(over.env.ok, false)
  assert.match(over.env.error.message, /exceeds the available channel/)
})

test('CONFIRMED P1M4-L0-4: an agent key whose session ended is refused, though the channel still holds money (G3, H-01)', async () => {
  const chain = funded()
  chain.setSession(consumer, ADDR.container, sessionAddr, nowS() - 1)
  const p = mkProvider(chain)
  const r = await p.invoke({ id: 'a', method: 'paid', params: {}, voucher: voucher(PRICE) })
  assert.equal(r.env.ok, false)
  assert.match(r.env.error.message, /not authorised or expired/)
})
