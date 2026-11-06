// The escrow token check: at start-up the provider reads its escrow's token() and refuses to serve paid
// calls through an escrow of another token than the one its manifest prices in (BEM on BNB Smart Chain, or
// createProvider({ escrowToken }) on a local chain). Fake chain; every case named FIXED D6-xx was checked by removing
// the line that implements it. The escrow (TapeAPIEscrow v3) is not audited and not deployed.
// 托管代币核对：启动时读托管的 token()，与清单计价的代币不一致就拒绝启动。假链。托管 v3 未审计、未部署。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createProvider } from '../src/index.js'
import { sig, abi, parseUnits, MAINNET } from '@tapeapi/sdk'
import { createFakeChain, ADDR } from '../../sdk/test/helpers/fake-chain.mjs'

const { privateKeyToAddress, signDigest, delegationDigest, voucherDigest } = sig
const SIGNER_KEY = '0x' + '22'.repeat(32), HOLDER_KEY = '0x' + '11'.repeat(32)
const signer = privateKeyToAddress(SIGNER_KEY)
const RPC = ['http://rpc1', 'http://rpc2']
const USDT = '0x55d398326f99059fF775485246999027B3197955'
const nowS = () => Math.floor(Date.now() / 1000)
function manifestOf(priced = true) {
  const expires = nowS() + 300 * 86400
  return {
    tapeapi: '0.1', name: 'T', circuits: ADDR.circuits, tokenId: '4246', container: ADDR.container, signer,
    delegation: { expires, sig: signDigest(delegationDigest(56, ADDR.hub, { container: ADDR.container, signer, expires }), HOLDER_KEY) },
    endpoints: { live: ['http://127.0.0.1/tapeapi/v1'], async: false },
    methods: [{ name: 'read', priceBEM: priced ? '0.0001' : '0', params: {}, returns: {} }],
    payment: { escrow: ADDR.escrow, unit: 'BEM', decimals: 8 },
  }
}
const mk = (chain, extra = {}) => {
  const logs = []
  const p = createProvider({ manifest: manifestOf(extra.priced ?? true), signerKey: SIGNER_KEY, rpcUrls: RPC, quorum: 2, chainId: 56, fetch: chain.fetch, allowHttp: true, allowMemoryStore: true, methods: { read: async () => ({}) }, log: (...a) => logs.push(a.join(' ')), ...extra })
  return { p, logs }
}

test('FIXED D6-01: an escrow that holds BEM: ok, and the provider starts', async () => {
  const chain = createFakeChain()
  const { p } = mk(chain)
  const r = await p.checkEscrowToken()
  assert.equal(r.status, 'ok'); assert.equal(r.token.toLowerCase(), MAINNET.bem.toLowerCase()); assert.equal(r.expected.toLowerCase(), MAINNET.bem.toLowerCase())
  const srv = await p.listen(0); await p.close(); assert.ok(srv)
})

test('FIXED D6-02: an escrow of another token: listen() refuses to start (UNSUPPORTED_PAYMENT_TOKEN, escrow-token-mismatch); with dev it starts and says so', async () => {
  const chain = createFakeChain()
  chain.setEscrowToken(ADDR.escrow, USDT)
  const { p } = mk(chain)
  const r = await p.checkEscrowToken()
  assert.equal(r.status, 'mismatch'); assert.equal(r.token, USDT)
  assert.match(r.message, /prices its methods in BEM/)
  // (a listen that wrongly starts is closed again, so the test fails instead of hanging / 误启动的也关掉：测试失败而不是挂住)
  await assert.rejects(p.listen(0).then(async (srv) => { await p.close(); return srv }), (e) => e.code === 'UNSUPPORTED_PAYMENT_TOKEN' && e.data?.reason === 'escrow-token-mismatch' && e.data.token === USDT)
  assert.equal(p.server, null, 'nothing is listening')
  const dev = mk(chain, { dev: true })
  await dev.p.listen(0); await dev.p.close()
  assert.ok(dev.logs.some((l) => /holds 0x55d3/.test(l) && /dev: starting anyway/.test(l)))
})

test('FIXED D6-03: escrowToken names the expected token (a local chain): that token is ok, BEM is then a mismatch; a malformed one is refused at once', async () => {
  const chain = createFakeChain()
  chain.setEscrowToken(ADDR.escrow, USDT)
  assert.equal((await mk(chain, { escrowToken: USDT }).p.checkEscrowToken()).status, 'ok')
  const other = createFakeChain()
  assert.equal((await mk(other, { escrowToken: USDT }).p.checkEscrowToken()).status, 'mismatch')
  assert.throws(() => mk(chain, { escrowToken: 'nope' }), (e) => e.code === 'INVALID_ARGUMENT')
  // another chain has no default: skipped until escrowToken is given / 其它链没有默认值：不给 escrowToken 就跳过
  assert.equal((await mk(chain, { chainId: 97 }).p.checkEscrowToken()).status, 'skipped')
})

test('FIXED D6-04: an escrow without token() and nodes that cannot answer are said in the log, never taken for a match; nothing to pay is skipped', async () => {
  const chain = createFakeChain()
  chain.setEscrowToken(ADDR.escrow, null)
  const a = mk(chain)
  assert.equal((await a.p.checkEscrowToken()).status, 'no-token')
  await a.p.listen(0); await a.p.close()
  assert.ok(a.logs.some((l) => /answers no token\(\)/.test(l)))
  // the nodes fail / 节点失败
  const down = createFakeChain()
  const failing = async (url, init) => { const b = JSON.parse(init.body); if (!Array.isArray(b) && b.method === 'eth_call') return new Response('{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"upstream down"}}', { status: 200, headers: { 'content-type': 'application/json' } }); return down.fetch(url, init) }
  const u = mk(down, { fetch: failing, rpcRetries: 0 })
  const r = await u.p.checkEscrowToken()
  assert.equal(r.status, 'unreadable'); assert.match(r.message, /could not be read/)
  // skipped: free only, no rpcUrls / 跳过：只有免费方法、没有 rpcUrls
  assert.equal((await mk(chain, { priced: false }).p.checkEscrowToken()).status, 'skipped')
  assert.equal((await mk(chain, { rpcUrls: [] }).p.checkEscrowToken()).status, 'skipped')
})

// ---- 3.0: the check guards every paid call, on both paths (handleRequest() with no listen(), and listen()) ----
// Before 3.0 a Worker had to await checkEscrowToken() itself, and 'unreadable' / 'no-token' only logged. Each case named
// FIXED D6-1x fails on the 2.x code (checked by stashing the change). / 3.0：每个付费调用都受核对约束，两条路径都一样。
const CONSUMER_KEY = '0x' + '33'.repeat(32)
const consumer = privateKeyToAddress(CONSUMER_KEY)
const PRICE = parseUnits('0.0001')
const voucherOf = (cumulative) => {
  const v = { consumer, provider: ADDR.container, cumulative: cumulative.toString(), expires: nowS() + 3600 }
  return { ...v, sig: signDigest(voucherDigest(56, ADDR.escrow, v), CONSUMER_KEY), signer: consumer }
}
const SECRET_RPC = 'https://rpc.example/v1/SECRET-KEY'
// A chain whose token() can be switched: 'ok' (BEM), USDT, 'none' (no token()), or 'down' (the nodes fail it). Counts the
// token() checks of the escrow that reach the nodes. / 可切换 token() 的链：BEM、USDT、没有 token()、节点读不出；数到达节点的 token() 核对次数。
function switchable(state = 'ok') {
  const chain = createFakeChain()
  chain.setChannel(consumer, ADDR.container, parseUnits('1'))
  const sel = abi.selector('escrowToken')
  const isToken = (b) => b?.method === 'eth_call' && String(b.params?.[0]?.to).toLowerCase() === ADDR.escrow.toLowerCase() && String(b.params?.[0]?.data).startsWith(sel)
  const s = { state, reads: 0 }
  s.set = (x) => { s.state = x; chain.setEscrowToken(ADDR.escrow, x === 'usdt' ? USDT : x === 'none' ? null : MAINNET.bem) }
  s.set(state)
  s.fetch = async (url, init) => {
    let body = null; try { body = JSON.parse(init?.body) } catch {}
    if (!Array.isArray(body) && isToken(body)) {
      if (String(url) === RPC[0]) s.reads++   // one per check (each check asks both quorum nodes) / 每次核对计一次（两个节点各问一次）
      if (s.state === 'down') return Response.json({ jsonrpc: '2.0', id: body.id, error: { code: -32000, message: `upstream down at ${SECRET_RPC}` } })
    }
    return chain.fetch(url, init)
  }
  return { chain, s }
}
const mkPaid = (s, extra = {}) => mk({ fetch: s.fetch }, { rpcRetries: 0, ...extra })
const call = (p, method, body) => p.handleRequest(new Request(`http://worker.test/tapeapi/v1/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), { clientIp: '203.0.113.9' })
const freeManifest = () => ({ ...manifestOf(true), methods: [{ name: 'read', priceBEM: '0.0001', params: {}, returns: {} }, { name: 'free', priceBEM: '0', params: {}, returns: {} }] })
const mk2 = (s, extra = {}) => mk({ fetch: s.fetch }, { rpcRetries: 0, manifest: freeManifest(), methods: { read: async () => ({ paid: true }), free: async () => ({ free: true }) }, ...extra })
const refusedWith = async (res, reason) => {
  assert.equal(res.status, 503)
  const b = await res.json()
  assert.equal(b.sig, undefined, 'unsigned: nothing is signed'); assert.equal(b.ok, false)
  assert.equal(b.error.code, 'UNSUPPORTED_PAYMENT_TOKEN'); assert.equal(b.error.data.reason, reason)
  assert.doesNotMatch(JSON.stringify(b), /SECRET-KEY|rpc\.example/, 'no node URL in the answer')
  return b
}

test('FIXED D6-10 (Worker path): with no listen() and no checkEscrowToken(), a mismatch refuses every paid call (unsigned 503, nothing billed); free calls are signed as before; the answer is kept', async () => {
  const { s } = switchable('usdt')
  const { p, logs } = mk2(s)
  const b = await refusedWith(await call(p, 'read', { id: 'a', params: {}, voucher: voucherOf(PRICE) }), 'escrow-token-mismatch')
  assert.equal(b.error.data.token, USDT); assert.equal(b.error.data.expected.toLowerCase(), MAINNET.bem.toLowerCase())
  // no voucher: refused too, never asked to pay / 不带凭证也拒绝，不报价
  await refusedWith(await call(p, 'read', { id: 'b', params: {} }), 'escrow-token-mismatch')
  const free = await (await call(p, 'free', { id: 'c', params: {} })).json()
  assert.equal(free.ok, true); assert.equal(typeof free.sig, 'string')
  assert.equal(s.reads, 1, 'a mismatch is a definite answer: read once')
  assert.equal(await p.store.get(consumer, ADDR.container), null, 'nothing billed')
  assert.equal(p.stats().escrowTokenRefused, 2); assert.equal(p.stats().delegationLapsed, 0)
  assert.ok(logs.some((l) => /holds 0x55d3/.test(l) && /paid calls are refused/.test(l)), 'the reason is in the log')
})

// R30B-8 (TAPI-22 §3.2, informative note): a mismatch is permanent for the instance, so a retry is pointless: even when
// the escrow would now answer BEM, the instance neither reads again nor serves. A new instance reads again.
// R30B-8：不一致对该实例是永久的，重试没有意义：即使托管现在会回答 BEM，该实例也不重读、不服务；新的实例才会重读。
test('R30B-8: escrow-token-mismatch is kept for the instance: a retry gets the same unsigned 503 with no new read; a new instance reads again', async () => {
  const { s } = switchable('usdt')
  const { p } = mk2(s)
  await refusedWith(await call(p, 'read', { id: 'a', params: {}, voucher: voucherOf(PRICE) }), 'escrow-token-mismatch')
  s.set('ok')
  await refusedWith(await call(p, 'read', { id: 'b', params: {}, voucher: voucherOf(PRICE) }), 'escrow-token-mismatch')
  assert.equal(s.reads, 1, 'kept: not read again')
  const fresh = mk2(s).p
  const ok = await (await call(fresh, 'read', { id: 'c', params: {}, voucher: voucherOf(PRICE) })).json()
  assert.equal(ok.ok, true, JSON.stringify(ok.error)); assert.equal(s.reads, 2)
})

// R30B-8: TAPI-22 (experimental) documents the unsigned 503 in both halves, without a new MUST/SHOULD/MAY; TAPI-21
// (frozen) is not where it is written. The guides say which reason is worth a retry.
// R30B-8：TAPI-22（实验性）中英两半都写了这个未签名 503，且没有新增 MUST/SHOULD/MAY；冻结的 TAPI-21 不写它。指南写明哪种原因值得重试。
test('R30B-8: TAPI-22 §3.2 and the guides describe the unsigned 503 UNSUPPORTED_PAYMENT_TOKEN and its three reasons, in English and Chinese', async () => {
  const { readFileSync } = await import('node:fs')
  const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8')
  const text = read('spec/TAPI-22.md'), at = text.indexOf('\n## 1. 摘要')
  assert.ok(at > 0)
  const en = text.slice(0, at), zh = text.slice(at)
  const sec = (half, from, to) => half.slice(half.indexOf(from), half.indexOf(to))
  const en32 = sec(en, '### 3.2 Provider Checks', '### 3.3 '), zh32 = sec(zh, '### 3.2 提供者校验', '### 3.3 ')
  for (const half of [en32, zh32]) {
    for (const k of ['UNSUPPORTED_PAYMENT_TOKEN', 'escrow-token-mismatch', 'escrow-no-token', 'escrow-token-unreadable', 'PROVIDER_UNAVAILABLE', 'TAPI-21 §3.2']) assert.ok(half.includes(k), k)
  }
  assert.match(en32, /kept for the life of that provider instance[^.]*do not retry/); assert.match(en32, /These two are not kept: the provider reads `token\(\)` again at the next paid call/)
  assert.match(zh32, /在该提供者实例的整个生命期内保留[^。]*不要重试/); assert.match(zh32, /这两种不保留：提供者在下一次付费调用时重新读取 `token\(\)`/)
  const count = (t, k) => (t.match(new RegExp(`\\b${k}\\b`, 'g')) || []).length
  for (const k of ['MUST NOT', 'MUST', 'SHOULD NOT', 'SHOULD', 'MAY', 'REQUIRED', 'OPTIONAL', 'RECOMMENDED']) assert.equal(count(en, k), count(zh, k), k)
  const note = (half, from) => half.slice(half.indexOf(from), half.indexOf('\n', half.indexOf(from)))
  for (const n of [note(en32, '**An escrow whose token is not confirmed'), note(zh32, '**托管代币未确认时')]) assert.doesNotMatch(n, /\b(MUST|SHOULD|MAY|REQUIRED|RECOMMENDED|OPTIONAL)\b/, 'informative: no new keyword')
  assert.doesNotMatch(read('spec/TAPI-21.md'), /escrow-token-mismatch/, 'TAPI-21 is frozen and does not carry it')
  assert.match(read('docs/guides/provide.md'), /`escrow-token-mismatch` is permanent for that instance/)
  assert.match(read('docs/guides/zh-CN/provide.md'), /`escrow-token-mismatch` 对该实例是永久的/)
  assert.match(read('docs/guides/consume.md'), /`escrow-token-mismatch` stays for that provider instance \(do\s+not retry\)/)
  assert.match(read('docs/guides/zh-CN/consume.md'), /`escrow-token-mismatch` 在该提供者实例内一直如此（不要重试）/)
})

test('FIXED D6-11 (Worker path): an escrow without token() refuses paid calls, and is asked again at the next paid call', async () => {
  const { s } = switchable('none')
  const { p } = mk2(s)
  await refusedWith(await call(p, 'read', { id: 'a', params: {}, voucher: voucherOf(PRICE) }), 'escrow-no-token')
  await refusedWith(await call(p, 'read', { id: 'b', params: {}, voucher: voucherOf(PRICE) }), 'escrow-no-token')
  assert.equal(s.reads, 2, 'no-token is not kept: read again')
  assert.equal((await (await call(p, 'free', { id: 'c', params: {} })).json()).ok, true)
  s.set('ok')   // e.g. the right escrow deployed at that address / 例如该地址上部署了正确的托管
  const ok = await (await call(p, 'read', { id: 'd', params: {}, voucher: voucherOf(PRICE) })).json()
  assert.equal(ok.ok, true, JSON.stringify(ok.error)); assert.equal(s.reads, 3)
})

test('FIXED D6-12 (Worker path): nodes that cannot read token() refuse paid calls without a node URL in the answer; a failed read is never kept as ok, and the next paid call reads again', async () => {
  const { s } = switchable('down')
  const { p, logs } = mk2(s)
  await refusedWith(await call(p, 'read', { id: 'a', params: {}, voucher: voucherOf(PRICE) }), 'escrow-token-unreadable')
  await refusedWith(await call(p, 'read', { id: 'b', params: {} }), 'escrow-token-unreadable')
  assert.equal(s.reads, 2)
  assert.ok(logs.some((l) => /could not be read/.test(l)), 'the details are in the log')
  s.set('ok')
  const ok = await (await call(p, 'read', { id: 'c', params: {}, voucher: voucherOf(PRICE) })).json()
  assert.equal(ok.ok, true, JSON.stringify(ok.error))
  // ok is kept: later failures of the nodes do not re-read or refuse / ok 被保留：之后节点故障不再重读、不拒绝
  s.set('down')
  const again = await (await call(p, 'read', { id: 'd', params: {}, voucher: voucherOf(2n * PRICE) })).json()
  assert.equal(again.ok, true, JSON.stringify(again.error)); assert.equal(s.reads, 3)
})

test('FIXED D6-13 (Worker path): an escrow that holds BEM serves the first paid call without any explicit check; concurrent first calls share one read', async () => {
  const { s } = switchable('ok')
  const { p } = mk2(s)
  const outs = await Promise.all([1n, 2n, 3n, 4n, 5n].map((k, i) => call(p, 'read', { id: `c${i}`, params: {}, voucher: voucherOf(k * PRICE) }).then((r) => r.json())))
  assert.equal(outs.filter((o) => o.ok).length >= 1, true)
  assert.ok(outs.every((o) => o.sig), 'every answer is a signed envelope (some may be stale vouchers, none refused)')
  assert.equal(s.reads, 1, 'one token() read for five concurrent first calls')
  assert.equal(p.stats().escrowTokenRefused, 0)
})

test('FIXED D6-14 (listen path): no-token and unreadable start the server and its paid calls are refused over HTTP; a mismatch still refuses to start; ok serves', async () => {
  for (const [state, reason] of [['none', 'escrow-no-token'], ['down', 'escrow-token-unreadable']]) {
    const { s } = switchable(state)
    const { p } = mk2(s)
    const srv = await p.listen(0)
    try {
      const url = (m) => `http://127.0.0.1:${srv.address().port}/tapeapi/v1/${m}`
      const post = (m, b) => fetch(url(m), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) })
      await refusedWith(await post('read', { id: 'a', params: {}, voucher: voucherOf(PRICE) }), reason)
      assert.equal((await (await post('free', { id: 'b', params: {} })).json()).ok, true, `${state}: free calls are served`)
      assert.equal(s.reads, 2, `${state}: listen() read once, the paid call read again`)
    } finally { await p.close() }
  }
  const mis = switchable('usdt')
  await assert.rejects(mk2(mis.s).p.listen(0), (e) => e.code === 'UNSUPPORTED_PAYMENT_TOKEN')
  const good = switchable('ok')
  const { p } = mk2(good.s)
  const srv = await p.listen(0)
  try {
    const r = await (await fetch(`http://127.0.0.1:${srv.address().port}/tapeapi/v1/read`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'a', params: {}, voucher: voucherOf(PRICE) }) })).json()
    assert.equal(r.ok, true, JSON.stringify(r.error)); assert.equal(good.s.reads, 1, 'the ok from listen() is kept')
  } finally { await p.close() }
})

test('D6-15: dev keeps its escape (no check before paid calls), and invoke() refuses as handleRequest() does', async () => {
  const { s } = switchable('usdt')
  const dev = mk2(s, { dev: true })
  const r = await dev.p.invoke({ id: 'a', method: 'read', params: {} })
  assert.equal(r.env.error.code, 'PAYMENT_REQUIRED', 'dev: as before')
  assert.equal(s.reads, 0, 'dev reads no token()')
  const live = mk2(s)
  const out = await live.p.invoke({ id: 'b', method: 'read', params: {}, voucher: voucherOf(PRICE) })
  assert.equal(out.status, 503); assert.equal(out.unsigned.error.data.reason, 'escrow-token-mismatch'); assert.equal(out.env, undefined)
})

test('D6-16: a provider with only free methods (as api.tapeapi.fun and relay.tapeapi.fun are) never reads token() and answers as before', async () => {
  const { s } = switchable('down')
  const { p } = mk({ fetch: s.fetch }, { priced: false })
  const res = await call(p, 'read', { id: 'a', params: {} })
  assert.equal(res.status, 200)
  const env = await res.json()
  assert.equal(env.ok, true); assert.equal(typeof env.sig, 'string')
  assert.equal(s.reads, 0, 'no token() read for a free service')
  assert.equal((await p.checkEscrowToken()).status, 'skipped')
  assert.equal(p.stats().escrowTokenRefused, 0)
})
