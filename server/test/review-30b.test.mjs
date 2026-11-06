// 3.0 adversarial review (local, night of 2026-10-29) of the escrow token check on every paid call (commit ffc72baa).
// Each test names its finding (R30B-<n>). FIXED: fails on the code before the fix (checked by stashing it).
// CONFIRMED: pins behaviour the review found and left as it is (a note). Fake chain; the escrow is not audited and not
// deployed. / 3.0 对抗性审查（本地）：每个付费调用前的托管代币核对。FIXED 在修复前失败（已用 stash 核对）；CONFIRMED 钉住审查确认、保持不变的行为。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createProvider } from '../src/index.js'
import { sig, abi, parseUnits, MAINNET } from '@tapeapi/sdk'
import { createFakeChain, ADDR } from '../../sdk/test/helpers/fake-chain.mjs'

const { privateKeyToAddress, signDigest, delegationDigest, voucherDigest } = sig
const SIGNER_KEY = '0x' + '22'.repeat(32), HOLDER_KEY = '0x' + '11'.repeat(32), CONSUMER_KEY = '0x' + '33'.repeat(32)
const signer = privateKeyToAddress(SIGNER_KEY), consumer = privateKeyToAddress(CONSUMER_KEY)
const RPC = ['http://rpc1', 'http://rpc2']
const USDT = '0x55d398326f99059fF775485246999027B3197955'
const PRICE = parseUnits('0.0001')
const nowS = () => Math.floor(Date.now() / 1000)
const manifest = () => {
  const expires = nowS() + 300 * 86400
  return {
    tapeapi: '0.1', name: 'T', circuits: ADDR.circuits, tokenId: '4246', container: ADDR.container, signer,
    delegation: { expires, sig: signDigest(delegationDigest(56, ADDR.hub, { container: ADDR.container, signer, expires }), HOLDER_KEY) },
    endpoints: { live: ['http://127.0.0.1/tapeapi/v1'], async: false },
    methods: [{ name: 'read', priceBEM: '0.0001', params: {}, returns: {} }, { name: 'free', priceBEM: '0', params: {}, returns: {} }],
    payment: { escrow: ADDR.escrow, unit: 'BEM', decimals: 8 },
  }
}
const voucherOf = (cumulative) => {
  const v = { consumer, provider: ADDR.container, cumulative: cumulative.toString(), expires: nowS() + 3600 }
  return { ...v, sig: signDigest(voucherDigest(56, ADDR.escrow, v), CONSUMER_KEY), signer: consumer }
}
// token() switchable between BEM ('ok'), USDT and 'down' (the nodes fail it); counts the token() checks that reach the
// nodes (one per check). / token() 可切换；数到达节点的 token() 核对次数。
function switchable(state) {
  const chain = createFakeChain()
  chain.setChannel(consumer, ADDR.container, parseUnits('1'))
  const sel = abi.selector('escrowToken')
  const isToken = (b) => b?.method === 'eth_call' && String(b.params?.[0]?.to).toLowerCase() === ADDR.escrow.toLowerCase() && String(b.params?.[0]?.data).startsWith(sel)
  const s = { reads: 0 }
  s.set = (x) => { s.state = x; chain.setEscrowToken(ADDR.escrow, x === 'usdt' ? USDT : MAINNET.bem) }
  s.set(state)
  s.fetch = async (url, init) => {
    let body = null; try { body = JSON.parse(init?.body) } catch {}
    if (!Array.isArray(body) && isToken(body)) {
      if (String(url) === RPC[0]) s.reads++
      if (s.state === 'down') return Response.json({ jsonrpc: '2.0', id: body.id, error: { code: -32000, message: 'upstream down' } })
    }
    return chain.fetch(url, init)
  }
  return s
}
const mk = (s, extra = {}) => createProvider({ manifest: manifest(), signerKey: SIGNER_KEY, rpcUrls: RPC, quorum: 2, chainId: 56, fetch: s.fetch, rpcRetries: 0, allowHttp: true, allowMemoryStore: true, methods: { read: async () => ({ paid: true }), free: async () => ({ free: true }) }, log: () => {}, ...extra })
const call = (p, body, ip = '203.0.113.9') => p.handleRequest(new Request('http://worker.test/tapeapi/v1/read', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), { clientIp: ip })

test('FIXED R30B-1: a paid call refused for an unconfirmed escrow token is unverified traffic: with a voucher it spends the free budget too, so one IP cannot make every request a fresh token() read of the nodes (TAPI-21 §3.4)', async () => {
  const s = switchable('down')
  const p = mk(s, { rateLimit: { free: 2, paid: 1000, ip: 1000 } })
  const statuses = []
  for (let i = 0; i < 6; i++) statuses.push((await call(p, { id: `v${i}`, params: {}, voucher: voucherOf(PRICE) })).status)
  assert.deepEqual(statuses.slice(0, 2), [503, 503], 'refused while the free budget lasts')
  assert.ok(statuses.slice(2).every((x) => x === 429), `then rate limited like any unverified call: ${statuses}`)
  assert.equal(s.reads, 2, 'no token() read once the free budget is spent')
  // A paying consumer is not affected once the token is confirmed: its calls do not touch the free budget.
  // 代币确认之后，付费消费者不受影响：它的调用不动免费预算。
  const ok = switchable('ok')
  const q = mk(ok, { rateLimit: { free: 1, paid: 1000, ip: 1000 } })
  for (let i = 1; i <= 4; i++) {
    const env = await (await call(q, { id: `p${i}`, params: {}, voucher: voucherOf(BigInt(i) * PRICE) })).json()
    assert.equal(env.ok, true, `paid call ${i}: ${JSON.stringify(env.error)}`)
  }
  assert.equal(ok.reads, 1)
})

test('FIXED R30B-2: provider.checkEscrowToken() returns the answer the instance keeps and never replaces it; it reads only while none is kept', async () => {
  const s = switchable('ok')
  const p = mk(s)
  assert.equal((await (await call(p, { id: 'a', params: {}, voucher: voucherOf(PRICE) })).json()).ok, true)
  // The v3 escrow's token is immutable, so this needs nodes that agree on another answer. The docs say a matching token
  // is kept for the life of the instance: an explicit check now returns it. / v3 托管的代币不可变；文档说一致的结果在实例存续期间保留，显式核对现在返回它。
  s.set('usdt')
  const kept = await p.checkEscrowToken()
  assert.equal(kept.status, 'ok', 'the kept ok, not a fresh mismatch')
  assert.equal(s.reads, 1, 'not read again')
  assert.equal((await (await call(p, { id: 'b', params: {}, voucher: voucherOf(2n * PRICE) })).json()).ok, true, 'paid calls still go on')
  // A kept mismatch is not replaced either. / 保留的不一致同样不被替换。
  const q = mk(s)
  assert.equal((await q.checkEscrowToken()).status, 'mismatch')
  s.set('ok')
  assert.equal((await q.checkEscrowToken()).status, 'mismatch')
  assert.equal((await call(q, { id: 'c', params: {}, voucher: voucherOf(PRICE) })).status, 503)
  // Nothing is kept while the nodes fail: each explicit check reads again, and the first success is kept.
  // 节点失败时什么都不保留：每次显式核对都重读，第一次成功的结果被保留。
  const d = switchable('down')
  const r = mk(d)
  assert.equal((await r.checkEscrowToken()).status, 'unreadable')
  d.set('ok')
  assert.equal((await r.checkEscrowToken()).status, 'ok')
  assert.equal(d.reads, 2)
})
