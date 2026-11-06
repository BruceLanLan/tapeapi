// Adversarial review of visitor grants (2026-10-22): each test is a finding, named
// FIXED <id> (it failed before the fix) or CONFIRMED <id> (a limit the code keeps, written down; the
// test pins today's behaviour so that a change is seen). Offline: injected chain reads and stores only.
// The review report itself is not in the repository; each test states its finding.
// 访客授权的对抗性审查：每个测试对应一条发现。FIXED（修复前失败）/ CONFIRMED（保留的限制，钉住现状）。离线。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as g from '@tapeapi/interop'
import * as sig from '@tapeapi/sdk/sig'
import { CHAINS } from '@tapeapi/sdk/chains'
import { toHex, keccak256, utf8ToBytes } from '@tapeapi/sdk/abi'

const HUB = CHAINS[56].hub
const USER_KEY = '0x' + '3a'.repeat(32)
const CALLER_KEY = '0x' + '4b'.repeat(32)
const ATTACKER_KEY = '0x' + '6d'.repeat(32)
const NOW = 1_791_000_000
const USER = sig.privateKeyToAddress(USER_KEY)
const B = { container: '0x' + '5e'.repeat(20), name: '13.7.tape' }
const MANIFEST = { methods: [{ name: 'history', grant: 'required', priceBEM: '0' }] }
const base = (over = {}) => g.makeGrant({
  user: USER, caller: '0x' + 'a6'.repeat(20), callerName: '12.7.tape', callerHolder: '0x' + '44'.repeat(20),
  callerKey: sig.privateKeyToAddress(CALLER_KEY), audience: B.container, audienceName: B.name, audienceHolder: '0x' + '66'.repeat(20),
  methods: ['history'], maxCalls: 100, now: NOW, nonce: '0x' + '01'.repeat(32), ...over,
})
const okChain = (m, counts = {}) => ({
  holderOf: async () => { counts.holderOf = (counts.holderOf ?? 0) + 1; return { holder: m.audienceHolder, status: 'ok' } },
  resolveName: async () => { counts.resolveName = (counts.resolveName ?? 0) + 1; return { container: m.caller, holder: m.callerHolder, status: 'ok' } },
  isValidSignature: async () => { counts.isValidSignature = (counts.isValidSignature ?? 0) + 1; return false },
})
// one request under `m`: the visitor's signature (or `userSig`), a proof by `key` over (id, method, params, ts)
const wireOf = (m, { id = 'r1', key = CALLER_KEY, userSig, ts = NOW, params = {}, proofSig } = {}) => {
  const hash = g.grantHashOf(56, HUB, m)
  const p = g.signCallProof({ audience: m.audience, grantHash: hash, id, method: 'history', params, ts }, key)
  return g.wireGrant({ chainId: 56, message: m, userSig: userSig ?? sig.signDigest(g.grantDigest(56, HUB, m), USER_KEY), proof: proofSig ? { ts, sig: proofSig } : p })
}
const verify = (wire, { id = 'r1', now = NOW, store, chain, params = {}, voucherSent = false, window } = {}) => g.verifyVisitorGrant(wire, {
  chainId: 56, hub: HUB, me: B, manifest: MANIFEST, method: 'history', id, params, voucherSent, now, store, chain, window,
})
// the kept-answer binding of a `history` call with empty params / history 空参数请求的绑定键
const REQ = toHex(keccak256(utf8ToBytes('{"method":"history","params":{}}')))
const revokeAt = (store, chain = {}) => g.grantRevokeHandler({ chainId: 56, hub: HUB, store, chain, clock: () => NOW })
const signedRevocation = (key, r) => ({ revocation: r, sig: g.signGrantRevocation(56, HUB, r, key) })

// ---------------------------------------------------------------------------------------------------------------
// FIXED IR-1 (medium): anyone could fill the revocation store with revocations of grant hashes the service never
// saw (24 per request, from keys made for the purpose); those have no known expiry, are never pruned, and a full
// store answers INTERNAL to every later revocation, including a visitor's real one. Now such "unseen" revocations
// have a budget of their own (maxUnseenRevocations, default half of maxRevocations): past it only another unseen one
// is refused; a revocation of a grant this service has seen, and revokedBefore, still have room.
// 任何人都能用"本服务从未见过的授权哈希"的撤销把撤销表塞满（每次 24 条，钥匙随手造），它们没有已知到期时间、
// 永不清理，表满后真实访客的撤销也被拒（INTERNAL）。现在"未见过"的撤销有单独的预算：超出时只拒绝新的未见撤销。
test('FIXED IR-1: unseen-hash revocations from throwaway keys cannot lock a visitor out of revoking a grant the service has seen', async () => {
  const store = g.memoryGrantStore({ clock: () => NOW, maxRevocations: 60 })
  const handler = revokeAt(store)
  // the visitor's real grant has been presented once (the service learned its expiry) / 真实授权出现过一次
  const m = base()
  const ok = await verify(wireOf(m), { store, chain: okChain(m) })
  assert.equal(ok.ok, true, ok.reason)
  await ok.lease.commit()
  // an attacker: throwaway keys, each revoking 24 random hashes / 攻击者：一次性钥匙，每把撤销 24 个随机哈希
  let refused = 0
  for (let i = 0; i < 5; i++) {
    const k = '0x' + (0x70 + i).toString(16).repeat(32)
    const hashes = Array.from({ length: 24 }, (_, j) => '0x' + (i * 24 + j + 1).toString(16).padStart(64, '0'))
    try { await handler(signedRevocation(k, { user: sig.privateKeyToAddress(k), grantHashes: hashes, revokedBefore: 0, issued: NOW })) } catch (e) { assert.equal(e.code, 'INTERNAL'); refused++ }
  }
  assert.ok(refused >= 1, 'the unseen budget is bounded')
  // the visitor can still revoke the grant it actually used, and by date / 访客仍能撤销用过的授权、按日期撤销
  const hash = g.grantHashOf(56, HUB, m)
  const r = await handler(signedRevocation(USER_KEY, { user: USER, grantHashes: [hash], revokedBefore: 0, issued: NOW }))
  assert.deepEqual(r.revoked.grantHashes, [hash])
  assert.equal((await verify(wireOf(m, { id: 'r2' }), { id: 'r2', store, chain: okChain(m) })).reason, 'revoked')
  await handler(signedRevocation(USER_KEY, { user: USER, grantHashes: [], revokedBefore: NOW, issued: NOW }))
  assert.equal(store.revocations().before, 1)
  assert.throws(() => g.memoryGrantStore({ maxUnseenRevocations: 0 }), /maxUnseenRevocations/)
})

// CONFIRMED IR-1b: revokedBefore takes one slot per visitor and is kept until revokedBefore + 7 days + 600 s; a
// revokedBefore far in the future (allowed up to 9999-12-31) is kept for ever. Keys cost nothing, so a flood of
// one-slot revocations from fresh keys can still fill the store; the remedy is a text decision (bound revokedBefore
// by issued + 300, or a quota per IP at the provider), proposed in the report, not made here.
// revokedBefore 每个访客占一格，保留到 revokedBefore + 7 天 + 600 秒；远期值（最多到 9999 年）永久保留。改法是文本决定，报告里提出。
test('CONFIRMED IR-1b: a far-future revokedBefore is accepted and never pruned', async () => {
  let now = NOW
  const store = g.memoryGrantStore({ clock: () => now, maxRevocations: 3 })
  const handler = g.grantRevokeHandler({ chainId: 56, hub: HUB, store, chain: {}, clock: () => now })
  await handler(signedRevocation(ATTACKER_KEY, { user: sig.privateKeyToAddress(ATTACKER_KEY), grantHashes: [], revokedBefore: 253_402_300_799, issued: NOW }))
  now = NOW + 365 * 86400
  store.revokeBefore(USER, now)            // forces a prune pass / 触发一次清理
  assert.equal(store.revocations().before, 2, 'the far-future entry is still there a year later')
})

// ---------------------------------------------------------------------------------------------------------------
// FIXED IR-2 (low, privacy): step 6 (revocation) ran before the call proof and the visitor's signature, so anyone,
// with no key of the visitor's, could forge a grant naming any `user` (with a callerKey of their own) and read
// `revoked` against `bad-user-signature`: a binary search on notBefore gave that visitor's revokedBefore at this
// service (that they use it, and when they revoked). Now the revocation is checked after the visitor's signature
// (step 9); a kept answer is never resent for a revoked grant.
// 第 6 步在调用证明与访客签名之前：任何人都能伪造写着任意 user 的授权，凭 revoked / bad-user-signature 的差别二分出该访客
// 在本服务的 revokedBefore。现在撤销在访客签名之后检查；被撤销的授权不再重发保留的回答。
test('FIXED IR-2: a forged grant for someone else\'s address does not tell whether that visitor revoked anything here', async () => {
  const store = g.memoryGrantStore({ clock: () => NOW })
  store.revokeBefore(USER, NOW - 100)               // the victim revoked everything before NOW - 100
  const probe = async (notBefore) => {
    const m = base({ notBefore, expires: notBefore + 3600, callerKey: sig.privateKeyToAddress(ATTACKER_KEY), now: NOW })
    return (await verify(wireOf(m, { key: ATTACKER_KEY, userSig: '0x' + '11'.repeat(65) }), { store, chain: okChain(m) })).reason
  }
  assert.equal(await probe(NOW - 200), 'bad-user-signature', 'before revokedBefore')
  assert.equal(await probe(NOW - 50), 'bad-user-signature', 'after revokedBefore: the same answer')
  // with the visitor's real signature, the revocation still holds / 有访客真签名时撤销照样生效
  const m = base({ notBefore: NOW - 200, expires: NOW + 3000 })
  assert.equal((await verify(wireOf(m), { store, chain: okChain(m) })).reason, 'revoked')
  // the reasons keep the order of the check / 原因按核验顺序
  const at = (r) => g.GRANT_REASONS.indexOf(r)
  assert.ok(at('bad-user-signature') < at('revoked') && at('revoked') < at('audience-holder-changed'))
})

test('FIXED IR-2: a retry of a delivered id is not answered with the kept envelope once the grant is revoked', async () => {
  const store = g.memoryGrantStore({ clock: () => NOW })
  const m = base()
  const hash = g.grantHashOf(56, HUB, m)
  const v = await verify(wireOf(m), { store, chain: okChain(m) })
  await v.lease.commit()
  store.keepAnswer(hash, 'r1', { ok: true, id: 'r1' }, { until: NOW + 300, req: REQ })
  const again = await verify(wireOf(m), { store, chain: okChain(m) })
  assert.equal(again.reason, 'replayed'); assert.ok(again.resend, 'kept answer handed back before revocation')
  store.revoke(USER, [hash], m.expires)
  const after = await verify(wireOf(m), { store, chain: okChain(m) })
  assert.equal(after.reason, 'replayed'); assert.equal(after.resend, undefined, 'no resend for a revoked grant')
})

// ---------------------------------------------------------------------------------------------------------------
// FIXED IR-3 (low): a request with the same (grant hash, id) as a call still in progress passed steps 9-11 (chain
// reads, an EIP-1271 call) and took a place in the perGrantWindow of (caller, visitor) before step 13 said
// `replayed`. Whoever saw one request (a log, a proxy) could resend it during the call and spend the visitor's window.
// Now step 8 also refuses an id in flight (store.inFlight), before any read or window.
// 与进行中调用同 (哈希, id) 的请求会先过第 9–11 步、占掉 (caller, 访客) 窗口的一格，到第 13 步才答 replayed。现在第 8 步就拒绝。
test('FIXED IR-3: a resend of a request still in flight is refused at step 8, costs no read and no place in the window', async () => {
  const store = g.memoryGrantStore({ clock: () => NOW })
  const m = base()
  const counts = {}
  const first = await verify(wireOf(m), { store, chain: okChain(m, counts), window: { calls: 2, windowS: 60 } })
  assert.equal(first.ok, true, first.reason)
  const before = { ...counts }
  for (let i = 0; i < 3; i++) assert.equal((await verify(wireOf(m), { store, chain: okChain(m, counts), window: { calls: 2, windowS: 60 } })).reason, 'replayed')
  assert.deepEqual(counts, before, 'no chain read for the resends')
  await first.lease.commit()
  const second = await verify(wireOf(m, { id: 'r2' }), { id: 'r2', store, chain: okChain(m, counts), window: { calls: 2, windowS: 60 } })
  assert.equal(second.ok, true, `the window still has room: ${second.reason}`)
})

// CONFIRMED IR-3b: a kept answer (G-3) is resent at step 8 to anyone who holds a copy of the original request
// within its proof's 300 s: the call proof is a bearer token for that one (id, params) for 300 s. The resend is the
// envelope the caller already had, so it gives a copier of the REQUEST the ANSWER (the visitor's data). Documented.
// 保留的回答在第 8 步重发给任何持有原请求副本的人（证明 300 秒内）：拿到请求副本的人就能拿到回答。写进文档。
test('CONFIRMED IR-3b: whoever replays a delivered request within 300 s gets the kept answer, without the window or the count', async () => {
  const store = g.memoryGrantStore({ clock: () => NOW })
  const m = base()
  const hash = g.grantHashOf(56, HUB, m)
  const v = await verify(wireOf(m), { store, chain: okChain(m), window: { calls: 1, windowS: 600 } })
  await v.lease.commit()
  store.keepAnswer(hash, 'r1', { ok: true, id: 'r1', result: { secret: 1 } }, { until: NOW + 300, req: REQ })
  const copy = wireOf(m)                     // the same bytes a log would hold (ts NOW) / 日志里的同一份字节
  for (let i = 0; i < 3; i++) assert.deepEqual((await verify(copy, { store, chain: okChain(m), window: { calls: 1, windowS: 600 } })).resend?.result, { secret: 1 })
  assert.equal(store.usedOf(hash), 1)
})

// ---------------------------------------------------------------------------------------------------------------
// FIXED IR-4 (low): an id with a lone UTF-16 surrogate was hashed through TextEncoder, which writes U+FFFD for it, so
// "\ud800" and "\udbff" had one call proof: a copy of a request could be resent under another id, as a new call
// (counted, answered). @tapeapi/server already refuses such ids (ID-LS); verifyVisitorGrant used by another provider
// did not. Now the call proof refuses an id that is not well-formed Unicode (bad-proof).
// 含孤立代理项的 id 经 TextEncoder 写成 U+FFFD，"\ud800" 与 "\udbff" 共用一份证明：可换 id 重放成新调用。现在证明拒绝它。
test('FIXED IR-4: two ids that differ only in lone surrogates no longer share a call proof', async () => {
  const store = g.memoryGrantStore({ clock: () => NOW })
  const m = base()
  const hash = g.grantHashOf(56, HUB, m)
  assert.throws(() => g.callProofPreimage({ audience: m.audience, grantHash: hash, id: 'a\ud800', method: 'history', params: {}, ts: NOW }), (e) => e.code === 'GRANT_INVALID' && /well-formed/.test(e.message))
  // a proof made the old way (U+FFFD for the lone surrogate) is refused under either id / 旧方式签出的证明在两个 id 下都被拒
  const p = g.signCallProof({ audience: m.audience, grantHash: hash, id: 'a�', method: 'history', params: {}, ts: NOW }, CALLER_KEY)
  for (const id of ['a\ud800', 'a\udbff']) {
    const wire = g.wireGrant({ chainId: 56, message: m, userSig: sig.signDigest(g.grantDigest(56, HUB, m), USER_KEY), proof: p })
    assert.equal((await verify(wire, { id, store, chain: okChain(m) })).reason, 'bad-proof', JSON.stringify(id))
  }
})

// ---------------------------------------------------------------------------------------------------------------
// FIXED IR-5 (low, DoS): a forged grant whose 65-byte userSig recovers to another address (or any longer userSig)
// reaches EIP-1271, and chainReadsFromApi asked eth_getCode on every such request, uncached: a forged grant was not
// "refused without a chain read" as both texts say. Now eth_getCode is cached per address (cacheS, both answers);
// a fresh `user` per request still costs one read (written in the report and the proposed text).
// 伪造授权的 userSig 恢复到别的地址（或更长）就会走 EIP-1271，每次都不缓存地问 eth_getCode。现在按地址缓存；
// 每次换一个 user 仍要读一次（报告与文本建议里写明）。
test('FIXED IR-5: forged signatures for one user cost one eth_getCode per cache window, not one per request', async () => {
  const calls = []
  const rpc = { call: async (m, a) => { calls.push(m); return '0x' }, ethCall: async () => { calls.push('eth_call'); return '0x' } }
  const reads = g.chainReadsFromApi({ siteStatus: async () => ({}) }, { rpc, chainId: 56, clock: () => NOW })
  const m = base()
  const store = g.memoryGrantStore({ clock: () => NOW })
  const chain = { ...okChain(m), isValidSignature: reads.isValidSignature }
  for (let i = 0; i < 5; i++) {
    const r = await verify(wireOf(m, { id: `f${i}`, userSig: sig.signDigest(g.grantDigest(56, HUB, m), ATTACKER_KEY) }), { id: `f${i}`, store, chain })
    assert.equal(r.reason, 'bad-user-signature')
  }
  assert.deepEqual(calls, ['eth_getCode'])
})

// ---------------------------------------------------------------------------------------------------------------
// FIXED IR-6 (low, operator mistake): a method whose descriptor says grant "required" but whose handler was not
// wrapped by grantMethods is served to anyone, with no grant and no record, and nothing said so.
// grantManifestProblems(manifest, { methods }) now names such a handler.
// 描述符写着 grant "required"、处理器却没被 grantMethods 包装：谁都能调用，且无任何提示。现在 grantManifestProblems 指出。
test('FIXED IR-6: grantManifestProblems names a method that takes grants whose handler grantMethods did not wrap', () => {
  const store = g.memoryGrantStore()
  const wrapped = g.grantMethods({ history: async () => ({}) }, { chainId: 56, hub: HUB, name: B.name, store, chain: okChain(base()) })
  const manifest = { methods: [{ name: 'history', grant: 'required', priceBEM: '0' }, { name: 'notes', grant: 'optional', priceBEM: '0' }, { name: 'profile', priceBEM: '0' }] }
  const problems = g.grantManifestProblems(manifest, { methods: { ...wrapped, notes: async () => ({}), profile: async () => ({}) } })
  assert.deepEqual(problems, ['notes: takes a grant but its handler is not wrapped by grantMethods: it would serve anyone without checking the grant'])
  assert.deepEqual(g.grantManifestProblems(manifest), [], 'without handlers: the manifest rules only, as before')
})

// ---------------------------------------------------------------------------------------------------------------
// CONFIRMED IR-7 (low): the holders are cached up to 60 s (TAP-10 §11), so a grant made before the caller's circuit
// changed hands is served under the old holder for up to a minute after the transfer, even on its first call, and the
// "for good" revocation of step 11 does not happen if no call falls after the cache expires and before the circuit
// returns. A fresh read on the first call of each grant was tried on this branch and taken back: self-signed grants
// (a new nonce per request) would get two uncached reads each. Proposal in the report (the transfer block in the grant,
// or the hub's logs: a format change).
// 持有人缓存最多 60 秒：易主前签的授权在易主后最多一分钟内仍按旧持有人服务（第一次调用也是）。曾试过"每份授权第一次调用不走缓存"，
// 因自签授权（每次换 nonce）每次都能逼出两次不缓存的读取而撤回。建议见报告。
test('CONFIRMED IR-7: inside the cache window, a grant presented for the first time after the caller changed hands is served', async () => {
  let holder = '0x' + '44'.repeat(20)
  const api = {
    siteStatus: async (q) => typeof q === 'string' ? { status: 'ok', container: '0x' + 'a6'.repeat(20), holder } : { status: 'ok', holder: '0x' + '66'.repeat(20) },
  }
  let now = NOW
  const reads = g.chainReadsFromApi(api, { chainId: 56, clock: () => now })
  const store = g.memoryGrantStore({ clock: () => now })
  const m1 = base({ nonce: '0x' + '02'.repeat(32) })
  const r1 = await verify(wireOf(m1), { store, chain: reads, now })     // warms the cache / 预热缓存
  assert.equal(r1.ok, true, r1.reason); await r1.lease.commit()
  holder = '0x' + '45'.repeat(20)                                      // the caller's circuit changes hands / 调用方电路易主
  now += 10
  const m2 = base({ nonce: '0x' + '03'.repeat(32), now })
  const r2 = await verify(wireOf(m2, { ts: now }), { store, chain: reads, now })
  assert.equal(r2.ok, true, 'served under the cached (old) holder')
  now += 60
  const r3 = await verify(wireOf(m2, { id: 'r3', ts: now }), { id: 'r3', store, chain: reads, now })
  assert.equal(r3.reason, 'caller-holder-changed', 'seen once the cache expired, and revoked for good from then on')
})

// CONFIRMED IR-7b: point reads cannot see a change that is undone between two calls: A -> B -> A with no call while B
// held the circuit (or within one cache window after the first call) leaves the grant valid, and a call within 60 s of
// a transfer is served under the old holder. TAPI-28 says "a changed caller holder revokes the grant for good"; that
// holds only for a change a read observes. Text fix proposed; a full fix needs the transfer history (a block in the
// grant, or the hub's logs), i.e. a format change.
// 点读看不到两次调用之间被撤回的变更：A→B→A 期间无调用（或在第一次调用后的缓存窗口内）授权仍有效；易主后 60 秒内的调用按旧持有人服务。
test('CONFIRMED IR-7b: A -> B -> A between two calls (or inside the cache window) is not seen; the grant stays valid', async () => {
  let holder = '0x' + '44'.repeat(20)
  const api = { siteStatus: async (q) => typeof q === 'string' ? { status: 'ok', container: '0x' + 'a6'.repeat(20), holder } : { status: 'ok', holder: '0x' + '66'.repeat(20) } }
  let now = NOW
  const reads = g.chainReadsFromApi(api, { chainId: 56, clock: () => now })
  const store = g.memoryGrantStore({ clock: () => now })
  const m = base()
  const r1 = await verify(wireOf(m), { store, chain: reads, now })
  assert.equal(r1.ok, true); await r1.lease.commit()
  holder = '0x' + '45'.repeat(20)            // transferred ... / 转出……
  now += 20
  const r2 = await verify(wireOf(m, { id: 'r2', ts: now }), { id: 'r2', store, chain: reads, now })
  assert.equal(r2.ok, true, 'inside the 60 s cache: served under the old holder')
  await r2.lease.commit()
  holder = '0x' + '44'.repeat(20)            // ... and back before the cache expires / ……缓存过期前又转回
  now += 50
  const r3 = await verify(wireOf(m, { id: 'r3', ts: now }), { id: 'r3', store, chain: reads, now })
  assert.equal(r3.ok, true, 'A -> B -> A unseen: the grant was never revoked')
})

// ---------------------------------------------------------------------------------------------------------------
// CONFIRMED IR-8 (design, format): GrantRevocation names no service. One signed revocation (say revokedBefore = now,
// meant for B, whose statement says "Revocable at any time with B") is accepted by every service on the chain that
// anyone hands it to: it revokes the visitor's grants at C too. The texts say "a revocation binds only the service that
// records it", which is true per store but not per intent. Fix needs a new type (an `audience` member): v2, proposed.
// GrantRevocation 不指名服务：一份签给 B 的撤销，任何人都能递给同链的 C，C 照收。修复要新类型（v2），只提出建议。
test('CONFIRMED IR-8: a revocation signed for one service is accepted by another service it was never meant for', async () => {
  const atB = g.memoryGrantStore({ clock: () => NOW }), atC = g.memoryGrantStore({ clock: () => NOW })
  const r = signedRevocation(USER_KEY, { user: USER, grantHashes: [], revokedBefore: NOW, issued: NOW })
  await revokeAt(atB)(r)
  await revokeAt(atC)(r)                       // relayed by someone else / 别人转递
  const atCgrant = base({ audience: '0x' + '5f'.repeat(20), audienceName: '14.7.tape', notBefore: NOW - 10, expires: NOW + 3000 })
  assert.equal(await atC.isRevoked(USER, g.grantHashOf(56, HUB, atCgrant), atCgrant.notBefore, atCgrant.expires), true)
})

// ---------------------------------------------------------------------------------------------------------------
// CONFIRMED IR-9 (text drift): the call proof refuses v 0 / 1 (TAPI-28 §3.9, the code: strictV); TAP #77 §5 says a
// verifier reads 0 or 1 as 27 or 28. And a proof.sig of the wrong length is `bad-proof` (TAPI-28 step 1/7, the code);
// #77 §7.1 step 1 makes it `malformed`. An implementer of #77 answers differently from the reference on both.
// 文本漂移：调用证明拒绝 v 0/1（TAPI-28、代码），#77 §5 说读作 27/28；长度错的 proof.sig 代码答 bad-proof，#77 第 1 步说 malformed。
test('CONFIRMED IR-9: v 0/1 in a call proof is bad-proof; a proof.sig of the wrong length is bad-proof, not malformed', async () => {
  const m = base()
  const p = wireOf(m).proof.sig
  const v01 = p.slice(0, -2) + (parseInt(p.slice(-2), 16) - 27).toString(16).padStart(2, '0')
  const store = g.memoryGrantStore({ clock: () => NOW })
  assert.equal((await verify(wireOf(m, { proofSig: v01 }), { store, chain: okChain(m) })).reason, 'bad-proof')
  assert.equal((await verify(wireOf(m, { proofSig: '0x1234' }), { store, chain: okChain(m) })).reason, 'bad-proof')
  // the visitor's 65-byte signature, by contrast, takes v 0/1 / 访客签名则接受 v 0/1
  const us = sig.signDigest(g.grantDigest(56, HUB, m), USER_KEY)
  const us01 = us.slice(0, -2) + (parseInt(us.slice(-2), 16) - 27).toString(16).padStart(2, '0')
  assert.equal((await verify(wireOf(m, { userSig: us01 }), { store, chain: okChain(m) })).ok, true)
})

// CONFIRMED IR-10: a grant together with a voucher is refused only at step 12, after the chain reads of steps 10-11
// (cached): a zero-cost check placed after the costly ones. Ordering is normative; a text change is proposed.
// grant 与 voucher 同时出现要到第 12 步（读链之后）才拒绝：零成本的检查排在有成本的检查之后。顺序是规范性的，只提文本建议。
test('CONFIRMED IR-10: grant + voucher is refused after the chain reads', async () => {
  const m = base(), counts = {}
  const r = await verify(wireOf(m), { store: g.memoryGrantStore({ clock: () => NOW }), chain: okChain(m, counts), voucherSent: true })
  assert.equal(r.reason, 'voucher-not-allowed')
  assert.deepEqual({ h: counts.holderOf, n: counts.resolveName }, { h: 1, n: 1 })
})

// CONFIRMED IR-11: the wire `maxCalls` is a JSON number; 1.0 and 1e0 parse to the integer 1 in JavaScript and are
// accepted (the hash is the same), while `true` is refused. A Python verifier reading `json.loads` gets 1.0 (float)
// and True (bool, an int subclass): an implementer must accept the first and refuse the second to agree. Proposed text.
// 线上 maxCalls 是 JSON 数字：JS 里 1.0、1e0 都是整数 1（同一哈希），true 被拒。Python 读到 1.0（float）与 True（bool 是 int 子类）。
test('CONFIRMED IR-11: maxCalls 1.0 / 1e0 on the wire are the integer 1; true is malformed', async () => {
  const m = base()
  const store = g.memoryGrantStore({ clock: () => NOW })
  for (const text of ['1.0', '1e0']) {
    const id = `n-${text}`
    const wire = JSON.parse(JSON.stringify(wireOf(base({ maxCalls: 1, nonce: '0x' + (text === '1.0' ? '0a' : '0b').repeat(32) }), { id })).replace('"maxCalls":1', `"maxCalls":${text}`))
    assert.equal(wire.message.maxCalls, 1)
    assert.equal((await verify(wire, { id, store, chain: okChain(m) })).ok, true, text)
  }
  const t = JSON.parse(JSON.stringify(wireOf(m)).replace('"maxCalls":100', '"maxCalls":true'))
  assert.equal((await verify(t, { id: 'z', store, chain: okChain(m) })).reason, 'malformed')
})

// ---------------------------------------------------------------------------------------------------------------
// FIXED IR-12 (low, memory): chainReadsFromApi's cache had no bound, and its keys are chosen by the requester (the
// caller name of a grant, the `user` of a forged signature): every new one stayed in memory for good. Now at most
// maxCacheEntries (default 10 000), oldest out first.
// 读链缓存没有上限，键又由请求方决定：每个新键永久留在内存里。现在至多 maxCacheEntries 条，旧的先出。
test('FIXED IR-12: the chain-read cache is bounded; an evicted entry is simply read again', async () => {
  let reads = 0
  const api = { siteStatus: async () => { reads++; return { status: 'ok', container: '0x' + 'a6'.repeat(20), holder: '0x' + '44'.repeat(20) } } }
  const c = g.chainReadsFromApi(api, { chainId: 56, clock: () => NOW, maxCacheEntries: 3 })
  for (let i = 1; i <= 5; i++) await c.resolveName(`${i}.7.tape`)
  await c.resolveName('5.7.tape')
  assert.equal(reads, 5, 'the newest is cached')
  await c.resolveName('1.7.tape')
  assert.equal(reads, 6, 'the oldest was evicted and is read again')
  assert.throws(() => g.chainReadsFromApi(api, { maxCacheEntries: 0 }), /maxCacheEntries/)
})

// CONFIRMED IR-13 (low, DoS): the name cache is keyed on `callerName`, which the requester writes. Self-signed grants
// (a key of one's own as `user`, valid signature) that name a new canonical name each time reach step 11 and cost one
// siteStatus read each, cache or not; a name that does not resolve costs the same. The remedy is in the server's limiter
// (count refused grants into fail:ip, listed as not done in PROGRESS-I1b), not in this module.
// 名字缓存按 callerName 分键，而 callerName 由请求方写：自签授权每次换一个规范名字，每次都要读一次链。补救在服务端限流器里。
test('CONFIRMED IR-13: a new callerName per self-signed grant costs one read per request', async () => {
  let reads = 0
  const api = { siteStatus: async (q) => { reads++; return typeof q === 'string' ? { status: 'not-a-name' } : { status: 'ok', holder: '0x' + '66'.repeat(20) } } }
  const c = g.chainReadsFromApi(api, { chainId: 56, clock: () => NOW })
  const store = g.memoryGrantStore({ clock: () => NOW })
  for (let i = 1; i <= 4; i++) {
    const m = base({ callerName: `${100 + i}.7.tape`, nonce: '0x' + String(i).padStart(2, '0').repeat(32) })
    assert.equal((await verify(wireOf(m, { id: `s${i}` }), { id: `s${i}`, store, chain: c })).reason, 'caller-name-mismatch')
  }
  assert.equal(reads, 1 + 4, 'one holder read (cached) and one name read per request')
})

// FIXED IR-2 (its cost): with the revocation after the signature, a revoked grant of a contract wallet reached the
// EIP-1271 call on every request; the answer is now cached per (address, digest, signature) for cacheS.
// 撤销移到签名之后，合约钱包被撤销的授权每次都会走到 EIP-1271；现在按 (地址, 摘要, 签名) 缓存答案。
test('FIXED IR-2 (cost): a revoked grant of a contract wallet costs one EIP-1271 call per cache window', async () => {
  const calls = []
  const rpc = { call: async (m) => { calls.push(m); return '0x6080' }, ethCall: async () => { calls.push('eth_call'); return '0x1626ba7e' + '0'.repeat(56) } }
  const reads = g.chainReadsFromApi({ siteStatus: async () => ({}) }, { rpc, chainId: 56, clock: () => NOW })
  const m = base()
  const store = g.memoryGrantStore({ clock: () => NOW })
  store.revoke(USER, [g.grantHashOf(56, HUB, m)], m.expires)
  const chain = { ...okChain(m), isValidSignature: reads.isValidSignature }
  for (let i = 0; i < 4; i++) assert.equal((await verify(wireOf(m, { id: `c${i}`, userSig: '0x' + '22'.repeat(70) }), { id: `c${i}`, store, chain })).reason, 'revoked')
  assert.deepEqual(calls, ['eth_getCode', 'eth_call'])
})
