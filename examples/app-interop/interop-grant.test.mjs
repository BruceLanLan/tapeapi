// examples/app-interop: the visitor grant (@tapeapi/interop; experimental) end to end on
// the fake chain: A asks, the visitor's wallet signs, A sends the top-level `grant` with a call proof, B checks it in the
// fixed order of its rules, serves, counts and writes its record into the signed answer; the visitor revokes. Each
// rule has a passing case and a refused one. Every refusal is asserted as B's SIGNED `BAD_REQUEST` with the message
// prefix `grant: <reason>`, no error.data, B's handler not run and the count not moved.
// A PROTOTYPE, not a TAP (its format text is spec/TAPI-28.md, Experimental; the code is authoritative); no service knows
// it. Local fake chain only.
// 访客授权端到端：每条规则一正一反。每个拒绝都断言：B 签名的 BAD_REQUEST、`grant: <原因>` 前缀、无 error.data、处理器未运行、
// 计数未变。原型，不是 TAP（格式说明见 spec/TAPI-28.md，以代码为准）。只在本地假链。
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { sig } from '@tapeapi/sdk'
import {
  makeGrant, grantDigest, grantHashOf, wireGrant, signCallProof, STATEMENT_TEMPLATES, MAX_GRANT_LIFE_S, grantReasonOf,
  grantRevocationDigest, grantForWallet, grantTypedData, grantManifestProblems, signGrant,
} from '@tapeapi/interop'
import { createInteropWorld, restoreTime, APP_A, APP_B, USER, USER_KEY, B_ORIGIN, HUB, CHAIN_ID, PRICE as _P } from './world.mjs'
import { discover, callChecked, askVisitorGrant, signedGrant, revocationRequest, planGrant, payerFor } from './app-a.mjs'
import { KEYS, addrOf, S2, AG } from '../../sdk/test/helpers/agent-chain.mjs'

afterEach(restoreTime)
const H = 3600
const lower = (a) => a.toLowerCase()

async function setup(opts) {
  const w = createInteropWorld(opts)
  const api = w.apiA()
  const { svc } = await discover(api, APP_B.name)
  return { w, api, svc }
}
// A grant built field by field (the tests need some that A's own helper would never build), signed by `signer`.
// 逐字段构造的授权（有些 A 自己的辅助函数绝不会构造），由 signer 签名。
async function grantFor(w, svc, { message: over = {}, signer = USER_KEY, now = w.clock(), callerKeyPk = sig.randomPrivateKey() } = {}) {
  const a = await w.chainA().resolveName(APP_A.name)
  const b = await w.chainA().resolveName(APP_B.name)
  const message = makeGrant({ user: USER, caller: a.container, callerName: APP_A.name, callerHolder: a.holder, callerKey: sig.privateKeyToAddress(callerKeyPk), audience: svc.container, audienceName: APP_B.name, audienceHolder: b.holder, methods: ['history'], maxCalls: 5, now, ...over })
  return { chainId: CHAIN_ID, hub: HUB, message, userSig: sig.signDigest(grantDigest(CHAIN_ID, HUB, message), signer), callerKeyPk, hash: grantHashOf(CHAIN_ID, HUB, message) }
}
// a raw request to B, as any client (or a man in the middle) could send it / 任何客户端（或中间人）都能发出的原始请求
async function raw(w, method, body) {
  const res = await w.fetch(`${B_ORIGIN}/tapeapi/v1/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return res.json()
}
const wireOf = (w, g, { id, method = 'history', params = {}, ts = w.clock(), key = g.callerKeyPk, message = g.message, userSig = g.userSig } = {}) =>
  wireGrant({ chainId: CHAIN_ID, message, userSig, proof: signCallProof({ audience: message.audience, grantHash: g.hash, id, method, params, ts }, key) })
// B's signed refusal: BAD_REQUEST, "grant: <reason>", no data / B 签名的拒绝
function reasonOf(env) {
  assert.equal(typeof env.sig, 'string', 'the refusal is signed')
  assert.equal(env.ok, false)
  assert.equal(env.error.code, 'BAD_REQUEST')
  assert.equal('data' in env.error, false, 'no error.data (TAP-13 §6: BAD_REQUEST has none)')
  return /^grant: ([a-z-]+)/.exec(env.error.message)?.[1]
}
const served = (env) => { assert.equal(env.ok, true, JSON.stringify(env.error)); return env.result }
const ran = (w) => w.appB.seen.filter((s) => s.method === 'history').length

test('the happy path and the count: three calls are calls 1, 2, 3 of 3 in B\'s signed records; the 4th is "exhausted" and B\'s handler does not run; B\'s handler sees ctx.grant naming A', async () => {
  const { w, api, svc } = await setup()
  const ask = await askVisitorGrant(w.chainA(), { svc, appA: APP_A, appB: APP_B, user: USER, methods: ['history'], maxCalls: 3, now: w.clock(), hub: HUB })
  const g = signedGrant(ask, w.wallet.signTypedData(ask.payload))
  for (let i = 1; i <= 3; i++) assert.deepEqual((await w.grants.call(api, svc, 'history', {}, g)).grant, { hash: ask.hash, used: i, maxCalls: 3 })
  await assert.rejects(w.grants.call(api, svc, 'history', {}, g), (e) => grantReasonOf(e) === 'exhausted')
  assert.equal(ran(w), 3)
  assert.equal(w.grantStore.usedOf(ask.hash), 3)
  const seen = w.appB.seen[0].grant
  assert.deepEqual([lower(seen.caller), seen.callerName, lower(seen.user), seen.used], [lower(APP_A.container), APP_A.name, lower(USER), 1])
  // the wallet was shown the statement first, the domain is the grant's own (never TAP-11's "TapeAPI") / 钱包首行与独立域
  const p = w.wallet.shown[0]
  assert.equal(p.types.VisitorGrant[0].name, 'statement')
  assert.equal(p.domain.name, 'TapeAPI Visitor Grant')
  assert.deepEqual(Object.keys(p).sort(), ['domain', 'message', 'primaryType', 'types'])
})

test('required: a method marked grant "required" is refused without one ("required"); with one it is served; public methods take none and run exactly as before', async () => {
  const { w, api, svc } = await setup()
  await assert.rejects(api.call(svc, 'history', {}), (e) => grantReasonOf(e) === 'required' && e.data === undefined)
  assert.equal(ran(w), 0)
  assert.equal((await callChecked(api, svc, 'profile', {})).result.caller, null)
  const g = await grantFor(w, svc)
  assert.equal((await w.grants.call(api, svc, 'history', {}, g)).grant.used, 1)
  assert.deepEqual(grantManifestProblems(w.manifest), [])
  assert.deepEqual(grantManifestProblems({ methods: [{ name: 'quote', priceBEM: '0.0001', grant: 'required' }, { name: 'x', priceBEM: '0', grant: 'always' }] }).length, 2)
})

test('method out of scope: a method not in the grant, and a grant naming a method B does not mark, are refused; the granted, marked method is served', async () => {
  const { w, api, svc } = await setup()
  const g = await grantFor(w, svc)
  // A refuses locally first; a raw request shows B refuses as well / A 先在本地拒绝；原始请求说明 B 也拒绝
  await assert.rejects(w.grants.call(api, svc, 'profile', {}, g), (e) => e.code === 'GRANT_INVALID')
  assert.equal(reasonOf(await raw(w, 'profile', { id: 'p1', method: 'profile', params: {}, grant: wireOf(w, g, { id: 'p1', method: 'profile' }) })), 'method-out-of-scope')
  const wide = await grantFor(w, svc, { message: { methods: ['history', 'profile'] } })
  assert.equal(reasonOf(await raw(w, 'history', { id: 'p2', method: 'history', params: {}, grant: wireOf(w, wide, { id: 'p2' }) })), 'method-out-of-scope')
  assert.equal(ran(w), 0)
  assert.equal(served(await raw(w, 'history', { id: 'p3', method: 'history', params: {}, grant: wireOf(w, g, { id: 'p3' }) })).grant.used, 1)
})

test('time: before notBefore (beyond the 300 s skew) and from expires on, "expired"; inside the window, served (revocation tier 0: expiry)', async () => {
  const { w, api, svc } = await setup()
  const early = await grantFor(w, svc, { now: w.clock() + 1000 })
  assert.equal(reasonOf(await raw(w, 'history', { id: 't1', method: 'history', params: {}, grant: wireOf(w, early, { id: 't1' }) })), 'expired')
  const g = await grantFor(w, svc, { message: { lifeS: 600 } })
  assert.equal((await w.grants.call(api, svc, 'history', {}, g)).grant.used, 1)
  w.advance(599)
  assert.equal((await w.grants.call(api, svc, 'history', {}, g)).grant.used, 2)
  w.advance(1)
  assert.equal(reasonOf(await raw(w, 'history', { id: 't2', method: 'history', params: {}, grant: wireOf(w, g, { id: 't2' }) })), 'expired')
  await assert.rejects(w.grants.call(api, svc, 'history', {}, g), (e) => e.code === 'GRANT_INVALID', 'A refuses an expired grant locally too')
  assert.equal(w.grantStore.usedOf(g.hash), 2)
})

test('life over the cap: 7 days + 1 s cannot be built (GRANT_INVALID) and B refuses it as "malformed"; exactly 7 days is served', async () => {
  const { w, api, svc } = await setup()
  const g = await grantFor(w, svc)
  assert.throws(() => makeGrant({ ...g.message, notBefore: w.clock(), expires: w.clock() + MAX_GRANT_LIFE_S + 1, now: w.clock() }), (e) => e.code === 'GRANT_INVALID' && /7 days/.test(e.message))
  const m = { ...g.message, expires: g.message.notBefore + MAX_GRANT_LIFE_S + 1 }
  m.statement = STATEMENT_TEMPLATES.en(m)
  assert.equal(reasonOf(await raw(w, 'history', { id: 'l1', method: 'history', params: {}, grant: wireOf(w, g, { id: 'l1', message: m }) })), 'malformed')
  const week = await grantFor(w, svc, { message: { lifeS: MAX_GRANT_LIFE_S } })
  assert.equal((await w.grants.call(api, svc, 'history', {}, week)).grant.used, 1)
})

test('caller key: a call proof signed by another key, or one bound to other params (a man in the middle), or older than 300 s, is "bad-proof"; A refuses a callerKeyPk that is not the grant\'s callerKey', async () => {
  const { w, api, svc } = await setup()
  const g = await grantFor(w, svc)
  assert.equal(reasonOf(await raw(w, 'history', { id: 'k1', method: 'history', params: {}, grant: wireOf(w, g, { id: 'k1', key: KEYS.stranger }) })), 'bad-proof')
  // the proof covers the params: changed on the way, it no longer holds / 证明覆盖 params：途中被改即失效
  assert.equal(reasonOf(await raw(w, 'history', { id: 'k2', method: 'history', params: { limit: 99 }, grant: wireOf(w, g, { id: 'k2', params: { limit: 1 } }) })), 'bad-proof')
  assert.equal(reasonOf(await raw(w, 'history', { id: 'k3', method: 'history', params: {}, grant: wireOf(w, g, { id: 'k3', ts: w.clock() - 301 }) })), 'bad-proof')
  await assert.rejects(w.grants.call(api, svc, 'history', {}, { ...g, callerKeyPk: KEYS.stranger }), (e) => e.code === 'GRANT_INVALID')
  assert.equal(ran(w), 0)
  assert.equal(served(await raw(w, 'history', { id: 'k4', method: 'history', params: {}, grant: wireOf(w, g, { id: 'k4', ts: w.clock() - 300 }) })).grant.used, 1)
})

test('audience: a grant for another service (or with another name) is "wrong-audience"; one naming a past holder of B, or B after it changed hands, is "audience-holder-changed"', async () => {
  const { w, svc } = await setup()
  const other = await grantFor(w, svc, { message: { audience: S2, audienceName: '14.7.tape' } })
  assert.equal(reasonOf(await raw(w, 'history', { id: 'a1', method: 'history', params: {}, grant: wireOf(w, other, { id: 'a1' }) })), 'wrong-audience')
  const stale = await grantFor(w, svc, { message: { audienceHolder: addrOf(KEYS.stranger) } })
  assert.equal(reasonOf(await raw(w, 'history', { id: 'a2', method: 'history', params: {}, grant: wireOf(w, stale, { id: 'a2' }) })), 'audience-holder-changed')
  const g = await grantFor(w, svc)
  assert.equal(served(await raw(w, 'history', { id: 'a3', method: 'history', params: {}, grant: wireOf(w, g, { id: 'a3' }) })).grant.used, 1)
  // B changes hands: B's own holder read (cached at most 60 s) no longer matches / B 易手
  w.x.chain.setOwner(13, addrOf(KEYS.stranger))
  w.advance(61)
  assert.equal(reasonOf(await raw(w, 'history', { id: 'a4', method: 'history', params: {}, grant: wireOf(w, g, { id: 'a4' }) })), 'audience-holder-changed')
})

test('replay: a delivered (grant, id) sent again for OTHER params is "replayed" and not counted (the kept answer is for the first params only); after a chain-read failure the same id is retried and served (nothing was recorded)', async () => {
  const { w, svc } = await setup()
  const g = await grantFor(w, svc)
  const body = { id: 'r1', method: 'history', params: {}, grant: wireOf(w, g, { id: 'r1' }) }
  assert.equal(served(await raw(w, 'history', body)).grant.used, 1)
  assert.equal(reasonOf(await raw(w, 'history', { id: 'r1', method: 'history', params: { limit: 1 }, grant: wireOf(w, g, { id: 'r1', params: { limit: 1 } }) })), 'replayed')
  assert.equal(w.grantStore.usedOf(g.hash), 1)
  // B's node fails during the check: the call fails (INTERNAL, generic), nothing is reserved; the retry with the same id
  // is served / 读链失败：调用失败、不预留；同 id 重试被服务
  const retry = { id: 'r2', method: 'history', params: {}, grant: wireOf(w, g, { id: 'r2' }) }
  w.chainFault(1)
  w.advance(61)                                    // past B's 60 s cache, so the holder is read again / 越过缓存
  const failed = await raw(w, 'history', retry)
  assert.equal(failed.ok, false); assert.equal(failed.error.code, 'INTERNAL')
  assert.equal(served(await raw(w, 'history', { ...retry, grant: wireOf(w, g, { id: 'r2' }) })).grant.used, 2)
})

test('no grant with a voucher: a request carrying both is "voucher-not-allowed", even on a free method; a priced method cannot take a grant, and A refuses a payer with a grant', async () => {
  const { w, api, svc } = await setup()
  const g = await grantFor(w, svc)
  const fake = { consumer: USER, provider: svc.container, cumulative: '1', expires: w.clock() + 600, sig: '0x' + '11'.repeat(65) }
  assert.equal(reasonOf(await raw(w, 'history', { id: 'v1', method: 'history', params: {}, voucher: fake, grant: wireOf(w, g, { id: 'v1' }) })), 'voucher-not-allowed')
  assert.equal(w.grantStore.usedOf(g.hash), 0)
  const fg = await planGrant(w.walletApi(), svc, { cap: 2n * _P, expires: w.clock() + H })
  for (const tx of fg.txs) w.wallet.send(tx)
  await assert.rejects(w.grants.call(api, svc, 'history', {}, g, { payer: payerFor(api, fg, { user: USER }) }), (e) => e.code === 'GRANT_INVALID' && /voucher/.test(e.message))
  assert.equal(served(await raw(w, 'history', { id: 'v2', method: 'history', params: {}, grant: wireOf(w, g, { id: 'v2' }) })).grant.used, 1)
})

test('revocation tier 1: the visitor signs a GrantRevocation, anyone delivers it to B\'s free grant_revoke, B\'s signed answer is the receipt, and the grant is "revoked"; one not signed by the visitor changes nothing; revokedBefore revokes every earlier grant', async () => {
  const { w, api, svc } = await setup()
  const ask = await askVisitorGrant(w.chainA(), { svc, appA: APP_A, appB: APP_B, user: USER, methods: ['history'], maxCalls: 5, now: w.clock(), hub: HUB })
  const g = signedGrant(ask, w.wallet.signTypedData(ask.payload))
  assert.equal((await w.grants.call(api, svc, 'history', {}, g)).grant.used, 1)
  const rev = revocationRequest({ user: USER, grantHashes: [ask.hash], issued: w.clock(), hub: HUB })
  // not the visitor's signature: refused, the grant still works / 非访客签名：拒绝，授权照常
  await assert.rejects(api.call(svc, 'grant_revoke', { revocation: rev.message, sig: sig.signDigest(grantRevocationDigest(CHAIN_ID, HUB, rev.message), KEYS.stranger) }), (e) => grantReasonOf(e) === 'bad-user-signature')
  assert.equal((await w.grants.call(api, svc, 'history', {}, g)).grant.used, 2)
  const receipt = await callChecked(api, svc, 'grant_revoke', { revocation: rev.message, sig: w.wallet.signTypedData(rev) })
  assert.equal(receipt.receipt.ok, true)
  assert.deepEqual(receipt.result.revoked.grantHashes, [ask.hash])
  await assert.rejects(w.grants.call(api, svc, 'history', {}, g), (e) => grantReasonOf(e) === 'revoked')
  // revokedBefore: every grant of this visitor that starts before t / 按时间撤销
  const g2 = await grantFor(w, svc)
  const g3 = await grantFor(w, svc, { now: w.clock() + 10 })
  const byDate = revocationRequest({ user: USER, grantHashes: [], revokedBefore: w.clock() + 5, issued: w.clock(), hub: HUB })
  await callChecked(api, svc, 'grant_revoke', { revocation: byDate.message, sig: w.wallet.signTypedData(byDate) })
  await assert.rejects(w.grants.call(api, svc, 'history', {}, g2), (e) => grantReasonOf(e) === 'revoked')
  w.advance(10)
  assert.equal((await w.grants.call(api, svc, 'history', {}, g3)).grant.used, 1, 'a grant starting after revokedBefore is not touched')
})

test('caller identity: a name that does not resolve to the stated container is "caller-name-mismatch"; when A changes hands the grant is "caller-holder-changed" for good, even after A goes back to the old holder', async () => {
  const { w, api, svc } = await setup()
  const lie = await grantFor(w, svc, { message: { caller: S2 } })
  assert.equal(reasonOf(await raw(w, 'history', { id: 'c1', method: 'history', params: {}, grant: wireOf(w, lie, { id: 'c1' }) })), 'caller-name-mismatch')
  const g = await grantFor(w, svc)
  assert.equal((await w.grants.call(api, svc, 'history', {}, g)).grant.used, 1)
  const old = (await w.chainA().resolveName(APP_A.name)).holder
  w.x.chain.setOwner(12, addrOf(KEYS.stranger))
  w.advance(61)
  await assert.rejects(w.grants.call(api, svc, 'history', {}, g), (e) => grantReasonOf(e) === 'caller-holder-changed')
  w.x.chain.setOwner(12, old)
  w.advance(61)
  await assert.rejects(w.grants.call(api, svc, 'history', {}, g), (e) => grantReasonOf(e) === 'revoked', 'back to the old holder: still refused (#29 item 4)')
  assert.equal(lower(AG), lower(APP_A.container))
})

// FIXED (2.x): the grant check reads names as the 2.0 default resolution does (TAP-10 site status at a pinned block): a
// name the default refuses as not-opened or unpaid is refused by the grant check too, with its own reason; it used to be
// read at latest without opening or activation, and accepted. / 授权核验按 2.0 默认解析读名字：默认因 not-opened、unpaid 拒绝的
// 名字，授权核验同样拒绝，并给出对应原因（以前读 latest、不查开通与激活，照样接受）。
test('TAP-10 site status: a caller or a service that is not opened or not activated is refused (caller-/audience-not-opened, -unpaid), as the 2.0 default refuses its name; uncounted', async () => {
  const { w, api, svc } = await setup()
  const g = await grantFor(w, svc)
  const call = (id) => raw(w, 'history', { id, method: 'history', params: {}, grant: wireOf(w, g, { id }) })
  // A not activated (isContainerLive false, no isLive): caller-unpaid / A 未激活
  w.activation.setActivation({ notLive: [APP_A.container] })
  assert.equal(reasonOf(await call('s1')), 'caller-unpaid')
  // A's own builder refuses a grant naming an unpaid app, as B would / A 的构造辅助同样拒绝
  await assert.rejects(askVisitorGrant(w.chainA(), { svc, appA: APP_A, appB: APP_B, user: USER, methods: ['history'], maxCalls: 3, now: w.clock(), hub: HUB }), (e) => e.code === 'GRANT_INVALID' && /12\.7\.tape is unpaid/.test(e.message))
  // A not opened by the container opener: caller-not-opened (TAP-10 §6.2 checks opening before activation) / A 未开通
  w.activation.setActivation({ notLive: [] }); w.x.setOpened(12, false); w.advance(61)
  assert.equal(reasonOf(await call('s2')), 'caller-not-opened')
  // B itself not activated: audience-unpaid / B 自己未激活
  w.x.setOpened(12, true); w.activation.setActivation({ notLive: [APP_B.container] }); w.advance(61)
  assert.equal(reasonOf(await call('s3')), 'audience-unpaid')
  assert.equal(ran(w), 0); assert.equal(w.grantStore.usedOf(g.hash), 0)
  // Both live again: served (the refusals recorded nothing). / 都恢复：照常服务（拒绝没有留下任何记录）。
  w.activation.setActivation({ notLive: [] }); w.advance(61)
  assert.equal(served(await call('s4')).grant.used, 1)
  assert.equal((await w.grants.call(api, svc, 'history', {}, g)).grant.used, 2)
})

test('statement: one that is not the v1 rendering of its fields is "statement-mismatch" at B, refused by grantForWallet before any wallet, and cannot be signed with signGrant; zh and en renderings are both accepted', async () => {
  const { w, api, svc } = await setup()
  const g = await grantFor(w, svc)
  const softer = { ...g.message, statement: g.message.statement.replace('At most 5 calls', 'At most a few calls') }
  assert.equal(reasonOf(await raw(w, 'history', { id: 's1', method: 'history', params: {}, grant: wireOf(w, g, { id: 's1', message: softer }) })), 'statement-mismatch')
  assert.throws(() => grantTypedData(CHAIN_ID, HUB, softer), (e) => e.code === 'GRANT_INVALID')
  assert.throws(() => signGrant(CHAIN_ID, HUB, softer, USER_KEY), (e) => e.code === 'GRANT_INVALID')
  const td = grantTypedData(CHAIN_ID, HUB, g.message)
  assert.throws(() => grantForWallet({ ...td, message: softer }, { chainId: CHAIN_ID, hub: HUB, callerName: APP_A.name, audienceName: APP_B.name }), (e) => e.code === 'GRANT_INVALID')
  assert.throws(() => grantForWallet(td, { chainId: CHAIN_ID, hub: HUB, callerName: '99.7.tape', audienceName: APP_B.name }), (e) => /page expects/.test(e.message))
  const zh = await grantFor(w, svc, { message: { lang: 'zh' } })
  assert.match(zh.message.statement, /^允许 12\.7\.tape 代表我调用 13\.7\.tape 的方法：history。.*本授权不含任何付款。/)
  assert.equal((await w.grants.call(api, svc, 'history', {}, zh)).grant.used, 1)
})

test('EIP-1271: a contract wallet\'s grant is served when the wallet approves the digest, refused ("bad-user-signature") when it does not, and a forged ECDSA signature is refused', async () => {
  const { w, api, svc } = await setup()
  const safe = '0x' + 'c0'.repeat(20)
  const a = await w.chainA().resolveName(APP_A.name)
  const b = await w.chainA().resolveName(APP_B.name)
  const ck = sig.randomPrivateKey()
  const message = makeGrant({ user: safe, caller: a.container, callerName: APP_A.name, callerHolder: a.holder, callerKey: sig.privateKeyToAddress(ck), audience: svc.container, audienceName: APP_B.name, audienceHolder: b.holder, methods: ['history'], maxCalls: 2, now: w.clock() })
  const digest = grantDigest(CHAIN_ID, HUB, message)
  const g = { chainId: CHAIN_ID, hub: HUB, message, userSig: '0x' + 'ab'.repeat(97), callerKeyPk: ck }
  w.x.chain.setCode(safe)
  await assert.rejects(w.grants.call(api, svc, 'history', {}, g), (e) => grantReasonOf(e) === 'bad-user-signature')
  w.x.chain.setContractHolder(safe, digest)
  assert.equal((await w.grants.call(api, svc, 'history', {}, g)).grant.used, 1)
  const forged = await grantFor(w, svc, { signer: KEYS.stranger })
  await assert.rejects(w.grants.call(api, svc, 'history', {}, forged), (e) => grantReasonOf(e) === 'bad-user-signature')
})

test('the record: a handler returning a non-object or its own "grant" member is INTERNAL and not counted; a B that ignores grants answers without the record, and A refuses it as GRANT_NOT_HONOURED, not a success', async () => {
  for (const bad of [async () => ['list'], async () => ({ grant: 'mine' })]) {
    const { w, api, svc } = await setup({ bHandlers: { history: bad } })
    const g = await grantFor(w, svc)
    await assert.rejects(w.grants.call(api, svc, 'history', {}, g), (e) => e.code === 'INTERNAL')
    assert.equal(w.grantStore.usedOf(g.hash), 0)
    restoreTime()
  }
  const { w, api, svc } = await setup({ grantAware: false })
  const g = await grantFor(w, svc)
  await assert.rejects(w.grants.call(api, svc, 'history', {}, g), (e) => e.code === 'GRANT_NOT_HONOURED')
  // and the request did carry the grant: an old server ignores a top-level member it does not know
  // 请求确实带了授权：旧服务端忽略不认识的顶层成员
  assert.ok(w.toB.at(-1).body.includes('"grant":{'))
})

test('no host of ours on the path: every request of the grant flow went to the fake chain\'s nodes or to B; none to tapeapi.fun', async () => {
  const { w, api, svc } = await setup()
  const g = await grantFor(w, svc)
  await w.grants.call(api, svc, 'history', {}, g)
  const origins = [...new Set(w.requests.map((u) => new URL(u).origin))].sort()
  assert.deepEqual(origins, ['http://rpc1', 'http://rpc2', B_ORIGIN].sort())
  assert.ok(!w.requests.some((u) => /tapeapi\.fun/.test(u)))
})

test('2.x line: the clients of this world say dev: true (the 1.x resolution, not deprecated): none of them reports DEPRECATED', async () => {
  const w = createInteropWorld()
  try {
    w.apiA(); w.chainA(); w.walletApi()
    assert.deepEqual(w.warnings.filter((x) => x.code === 'DEPRECATED'), [])
  } finally { w.close() }
})

// FIXED G-6: the provider's handler timeout cannot reach grantMethods, so a handler that outlived it used to commit (count)
// a call whose answer was never sent. grantMethods now has its own deadline, below the provider's: past it, the call is
// released and answered INTERNAL, and the handler that finishes later is not counted.
// 服务端的处理器超时够不到 grantMethods：超时后才完成的处理器过去会为没发出的回答计一次。现在包装器有自己的、更短的时限。
test('FIXED G-6: a handler slower than grantMethods\' deadline (set below the provider\'s handlerTimeoutMs) is answered INTERNAL and never counted, even when it finishes later; a fast one is served', async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  // the handler waits for the test (not for a clock), so a loaded machine cannot change the order of events
  // 处理器等测试放行（不等时钟），机器再忙也不会改变事件顺序
  let started = 0, finished = 0, open, gate = new Promise((r) => { open = r })
  const history = async (params, ctx) => { started++; await gate; finished++; return { visitor: ctx.grant?.user ?? null, items: [] } }
  const { w, svc } = await setup({ bHandlers: { history }, grantOptions: { timeoutMs: 200 }, providerOptions: { handlerTimeoutMs: 400 } })
  const g = await grantFor(w, svc)
  const timedOut = await raw(w, 'history', { id: 'to1', method: 'history', params: {}, grant: wireOf(w, g, { id: 'to1' }) })
  assert.equal(timedOut.ok, false); assert.equal(timedOut.error.code, 'INTERNAL')
  open()                                            // now let the handler finish, after the answer went out / 回答发出后才放行
  for (let i = 0; i < 100 && finished < started; i++) await sleep(20)
  await sleep(20)
  assert.equal(finished, started, 'whatever started has finished')
  assert.equal(w.grantStore.usedOf(g.hash), 0, 'and it was not counted')
  assert.equal(w.grantStore.delivered(g.hash, 'to1'), false, 'nor recorded: the same id can be sent again')
  assert.equal(served(await raw(w, 'history', { id: 'to1', method: 'history', params: {}, grant: wireOf(w, g, { id: 'to1' }) })).grant.used, 1)
  const { GRANT_HANDLER_TIMEOUT_MS, grantMethods } = await import('@tapeapi/interop')
  assert.ok(GRANT_HANDLER_TIMEOUT_MS < 25_000, 'the default is below the provider\'s default handlerTimeoutMs')
  for (const timeoutMs of [0, -1, 1.5, '20']) assert.throws(() => grantMethods({}, { chainId: CHAIN_ID, hub: HUB, name: APP_B.name, store: w.grantStore, chain: w.bChain, timeoutMs }), /timeoutMs must be a positive integer/)
})

// Step 13 (the rate-limit key): perGrantWindow limits the calls of one (caller, visitor) across their grants; keyed on what the
// check proved, so a grant the visitor did not sign cannot spend the visitor's window; off by default.
// 第 13 步（限流键）：perGrantWindow 按（调用方, 访客）跨授权限量；按核验已证明的身份分桶，访客没签的授权耗不掉它；默认关。
test('step 13 (rate-limit key): with perGrantWindow { calls: 2, windowS: 60 } the 3rd call of a caller for a visitor is "rate-limited" across two grants, uncounted, handler not run; forged grants in the visitor\'s name do not spend the window; it slides back; off by default', async () => {
  const { w, api, svc } = await setup({ grantOptions: { perGrantWindow: { calls: 2, windowS: 60 } } })
  const g1 = await grantFor(w, svc)
  const g2 = await grantFor(w, svc)
  // five forged grants in the visitor's name (signed by someone else): refused at the signature, before the window
  // 以访客名义伪造的五份授权（别人签的）：在签名一步就被拒，轮不到窗口
  for (let i = 0; i < 5; i++) {
    const forged = await grantFor(w, svc, { signer: KEYS.stranger })
    assert.equal(reasonOf(await raw(w, 'history', { id: `f${i}`, method: 'history', params: {}, grant: wireOf(w, forged, { id: `f${i}` }) })), 'bad-user-signature')
  }
  assert.equal((await w.grants.call(api, svc, 'history', {}, g1)).grant.used, 1)
  assert.equal((await w.grants.call(api, svc, 'history', {}, g2)).grant.used, 1)
  const before = ran(w)
  const limited = await raw(w, 'history', { id: 'w3', method: 'history', params: {}, grant: wireOf(w, g1, { id: 'w3' }) })
  assert.equal(reasonOf(limited), 'rate-limited')
  assert.match(limited.error.message, /retry in \d+ s/)
  assert.equal(ran(w), before, 'the handler did not run')
  assert.equal(w.grantStore.usedOf(g1.hash), 1, 'not counted')
  // another visitor of the same caller has a window of its own / 同一调用方的另一位访客有自己的窗口
  const otherKey = '0x' + '5c'.repeat(32)
  const other = await grantFor(w, svc, { message: { user: addrOf(otherKey) }, signer: otherKey })
  assert.equal((await w.grants.call(api, svc, 'history', {}, other)).grant.used, 1)
  w.advance(120)
  assert.equal((await w.grants.call(api, svc, 'history', {}, g1)).grant.used, 2, 'the window slid back')
  restoreTime()
  // off by default: the same five calls in a row are all served / 默认关：同样连续调用全部服务
  const d = await setup()
  const g = await grantFor(d.w, d.svc)
  for (let i = 1; i <= 5; i++) assert.equal((await d.w.grants.call(d.api, d.svc, 'history', {}, g)).grant.used, i)
  const { grantMethods } = await import('@tapeapi/interop')
  const opts = { chainId: CHAIN_ID, hub: HUB, name: APP_B.name, chain: d.w.bChain }
  assert.throws(() => grantMethods({}, { ...opts, store: d.w.grantStore, perGrantWindow: { calls: 0, windowS: 60 } }), /perGrantWindow must be/)
  assert.throws(() => grantMethods({}, { ...opts, store: { ...d.w.grantStore, take: undefined }, perGrantWindow: { calls: 2, windowS: 60 } }), /needs a store with take/)
})

// FIXED G-3: B delivered and counted a call, the answer was lost on the way back, and the SDK's stable `call` retried the
// same id on the next endpoint: B used to refuse it "replayed" (one call used, the caller sees a failure). Now B sends the
// envelope it signed the first time again, byte for byte: not signed again, not counted again, the receipt unchanged.
// 交付后回答丢失、SDK 同 id 换端点重试：过去 B 答 replayed（扣了一次、调用方看到失败）；现在 B 原样重发首次签好的信封，不重签、不再计次。
const rawText = async (w, method, body) => (await w.fetch(`${B_ORIGIN}/tapeapi/v1/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).text()

test('FIXED G-3: the SDK\'s retry of the same id after a lost answer gets the first signed envelope byte for byte; counted once, handler run once, and A\'s checks (B\'s signature, the grant record) pass', async () => {
  const { w, api, svc } = await setup({ secondEndpoint: true })
  assert.equal(svc.manifest.endpoints.live.length, 2)
  const g = await grantFor(w, svc)
  w.dropAnswers(1)                                  // B serves the first try; its answer never comes back / 首次的回答丢失
  const r = await w.grants.call(api, svc, 'history', {}, g)
  assert.equal(r.grant.used, 1, 'the call A sees is call 1')
  assert.equal(w.grantStore.usedOf(g.hash), 1, 'counted once')
  assert.equal(ran(w), 1, 'B\'s handler ran once')
  assert.equal(w.toB.length, 2, 'the SDK sent the same id twice, to two endpoints')
  assert.deepEqual(w.toB.map((t) => JSON.parse(t.body).id), [r.id, r.id])
  assert.equal(w.fromB[1], w.fromB[0], 'the retry got the first envelope, byte for byte')
  assert.equal(JSON.parse(w.fromB[1]).sig, r.sig)
})

test('FIXED G-3: by raw request: the same request again is answered with the identical bytes, the signature still B\'s over this id; not counted, handler not run', async () => {
  const { w, svc } = await setup()
  const g = await grantFor(w, svc)
  const body = { id: 'k1', method: 'history', params: {}, grant: wireOf(w, g, { id: 'k1' }) }
  const first = await rawText(w, 'history', body)
  w.advance(5)                                      // a later retry, with a fresh proof ts / 稍后的重试，证明 ts 是新的
  const again = await rawText(w, 'history', { ...body, grant: wireOf(w, g, { id: 'k1' }) })
  assert.equal(again, first)
  const env = JSON.parse(again)
  assert.equal(sig.recoverResponseSigner({ container: env.container, id: 'k1', method: 'history', params: {}, ok: true, body: env.result, ts: env.ts }, env.sig), sig.privateKeyToAddress(KEYS.providerSigner))
  assert.equal(w.grantStore.usedOf(g.hash), 1)
  assert.equal(ran(w), 1)
})

test('FIXED G-3: the kept answer leaks to nobody: another grant with the same id is served on its own (its own hash and count); the same grant and id without the caller key is "bad-proof"; other params are "replayed"', async () => {
  const { w, svc } = await setup()
  const g = await grantFor(w, svc)
  const first = await rawText(w, 'history', { id: 'x1', method: 'history', params: {}, grant: wireOf(w, g, { id: 'x1' }) })
  // another grant of the same visitor (another one-off key), same id / 同一访客的另一份授权（另一把一次性钥匙），同一个 id
  const other = await grantFor(w, svc)
  const theirs = await rawText(w, 'history', { id: 'x1', method: 'history', params: {}, grant: wireOf(w, other, { id: 'x1' }) })
  assert.notEqual(theirs, first)
  assert.equal(JSON.parse(theirs).result.grant.hash, other.hash)
  assert.equal(JSON.parse(theirs).result.grant.used, 1)
  // the grant itself, but the proof signed by someone without its callerKey / 同一份授权，但证明不是 callerKey 签的
  assert.equal(reasonOf(await raw(w, 'history', { id: 'x1', method: 'history', params: {}, grant: wireOf(w, g, { id: 'x1', key: KEYS.stranger }) })), 'bad-proof')
  assert.equal(reasonOf(await raw(w, 'history', { id: 'x1', method: 'history', params: { a: 1 }, grant: wireOf(w, g, { id: 'x1', params: { a: 1 } }) })), 'replayed')
  assert.equal(w.grantStore.usedOf(g.hash), 1)
})

test('FIXED G-3: kept for at most 300 s after its ts (a client refuses an older answer), then "replayed"; maxAnswers: 0 keeps none; the oldest answer goes first when the store is full', async () => {
  const { w, svc } = await setup()
  const g = await grantFor(w, svc)
  const body = (id) => ({ id, method: 'history', params: {}, grant: wireOf(w, g, { id }) })
  const first = await rawText(w, 'history', body('t1'))
  w.advance(300)
  assert.equal(await rawText(w, 'history', body('t1')), first, 'at 300 s, still')
  w.advance(1)
  assert.equal(reasonOf(await raw(w, 'history', body('t1'))), 'replayed', 'at 301 s: gone')
  restoreTime()
  const none = await setup({ storeOptions: { maxAnswers: 0 } })
  const g0 = await grantFor(none.w, none.svc)
  const b0 = { id: 'n1', method: 'history', params: {}, grant: wireOf(none.w, g0, { id: 'n1' }) }
  served(await raw(none.w, 'history', b0))
  assert.equal(reasonOf(await raw(none.w, 'history', b0)), 'replayed')
  restoreTime()
  const two = await setup({ storeOptions: { maxAnswers: 2 } })
  const g2 = await grantFor(two.w, two.svc)
  const b2 = (id) => ({ id, method: 'history', params: {}, grant: wireOf(two.w, g2, { id }) })
  const kept = []
  for (const id of ['o1', 'o2', 'o3']) kept.push(await rawText(two.w, 'history', b2(id)))
  assert.deepEqual(two.w.grantStore.answers().count, 2)
  assert.equal(reasonOf(await raw(two.w, 'history', b2('o1'))), 'replayed', 'the oldest was dropped')
  assert.equal(await rawText(two.w, 'history', b2('o3')), kept[2])
})

test('FIXED G-3: only an answer B actually signed and sent is kept: a result B refuses to send (over 1 MiB) is not kept, and its retry is "replayed" (the known count-before-sign limit), never someone else\'s envelope', async () => {
  let big = true
  const history = async (params, ctx) => ({ visitor: ctx.grant?.user ?? null, items: big ? ['x'.repeat(1_100_000)] : [] })
  const { w, svc } = await setup({ bHandlers: { history } })
  const g = await grantFor(w, svc)
  const body = { id: 'b1', method: 'history', params: {}, grant: wireOf(w, g, { id: 'b1' }) }
  const refused = await raw(w, 'history', body)
  assert.equal(refused.ok, false); assert.equal(refused.error.code, 'INTERNAL')
  assert.equal(w.grantStore.answers().count, 0, 'nothing kept')
  big = false
  assert.equal(reasonOf(await raw(w, 'history', body)), 'replayed')
})

test('FIXED G-3 (server hooks): a priced call is never answered with a saved envelope: ctx.resend on a call carrying a voucher is INTERNAL and the voucher is not billed', async () => {
  let saved = null
  const quote = async (params, ctx) => { if (saved) return ctx.resend(saved); ctx.onSigned((env) => { saved = env }); return { quote: { pair: 'BEM/USD' } } }
  const { w, api, svc } = await setup({ bHandlers: { quote } })
  const fg = await planGrant(w.walletApi(), svc, { cap: 3n * _P, expires: w.clock() + H })
  for (const tx of fg.txs) w.wallet.send(tx)
  const payer = payerFor(api, fg, { user: USER })
  await api.call(svc, 'quote', {}, { payer, id: 'q1' })
  assert.equal(payer.cumulativeOf(svc), _P)
  await assert.rejects(api.call(svc, 'quote', {}, { payer, id: 'q1' }), (e) => e.code === 'INTERNAL')
  assert.equal((await w.provider.pendingSettlements())[0].cumulative, String(_P), 'B holds only the first voucher')
})
