// @tapeapi/interop (experimental): the visitor-grant format's own rules, offline. The
// end-to-end behaviour (a provider, the fake chain, A and B) is examples/app-interop/interop-grant.test.mjs.
// spec/vectors/interop-visitor-grant.json is a SELF-TEST vector set (not a TAP's assets): this file rebuilds it byte for
// byte, spec/vectors/verify.py (an independent Python implementation) recomputes its hashes and recovers its signers, and
// contracts/test/VisitorGrantTypehash.t.sol recomputes one grant and one revocation in Solidity.
// Regenerate (only when the format deliberately changes, with a new `v`): TAPEAPI_WRITE_VECTORS=1 node --test interop/test/interop.test.mjs
// 访客授权格式自身的规则（离线）。向量是自测向量（不是 TAP 附件）：本文件逐字节重建，verify.py 独立复算哈希与签名者。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import * as g from '@tapeapi/interop'
import * as sig from '@tapeapi/sdk/sig'
import * as agent from '../../sdk/src/agent-sig.js'
import { toHex, keccak256, utf8ToBytes } from '@tapeapi/sdk/abi'
import { CHAINS } from '@tapeapi/sdk/chains'
import { importsOf } from '../../scripts/build-playground.mjs'

// the BNB Smart Chain DeWEB hub as the SDK lists it: the verifyingContract this prototype uses
const HUB = CHAINS[56].hub
const USER_KEY = '0x' + '3a'.repeat(32)
const CALLER_KEY = '0x' + '4b'.repeat(32)
const NOW = 1_791_000_000
const base = (over = {}) => g.makeGrant({
  user: sig.privateKeyToAddress(USER_KEY), caller: '0x' + 'a6'.repeat(20), callerName: '12.7.tape', callerHolder: '0x' + '44'.repeat(20),
  callerKey: sig.privateKeyToAddress(CALLER_KEY), audience: '0x' + '5e'.repeat(20), audienceName: '13.7.tape', audienceHolder: '0x' + '66'.repeat(20),
  methods: ['history'], maxCalls: 100, now: NOW, nonce: '0x' + '01'.repeat(32), ...over,
})
const bad = (f, re) => assert.throws(f, (e) => e.code === 'GRANT_INVALID' && (!re || re.test(e.message)))

test('its own domain: never TAP-11\'s "TapeAPI" domain nor the voucher domain; a signature over one type is never one over another (tested both ways)', () => {
  const m = base()
  const d = g.grantDomain(56, HUB)
  assert.deepEqual(d, { name: 'TapeAPI Visitor Grant', version: '1', chainId: 56, verifyingContract: HUB })
  assert.notEqual(g.grantDomainSeparator(56, HUB), toHex(sig.domainSeparator(sig.delegationDomain(56, HUB))))
  assert.notEqual(g.grantDomainSeparator(56, HUB), toHex(sig.domainSeparator(sig.voucherDomain(56, HUB))))
  const s = g.signGrant(56, HUB, m, USER_KEY)
  const user = sig.privateKeyToAddress(USER_KEY)
  assert.equal(sig.recoverAddress(g.grantDigest(56, HUB, m), s), user)
  // the same struct hash under the TAP-11 domain is another digest / 同一结构哈希在 TAP-11 域下是另一个摘要
  assert.notEqual(toHex(sig.typedDigest(sig.delegationDomain(56, HUB), g.hashVisitorGrant(m))), g.grantHashOf(56, HUB, m))
  const rev = { user, grantHashes: [g.grantHashOf(56, HUB, m)], revokedBefore: 0, issued: NOW }
  const rs = g.signGrantRevocation(56, HUB, rev, USER_KEY)
  const others = [
    g.grantRevocationDigest(56, HUB, rev), sig.delegationDigest(56, HUB, { container: m.audience, signer: user, expires: m.expires }),
    sig.voucherDigest(56, HUB, { consumer: user, provider: m.audience, cumulative: 1n, expires: m.expires }),
    agent.mandateDigest(56, HUB, { principal: m.audience, agent: m.caller, agentKey: m.callerKey, mode: 0, taskHash: '0x' + '12'.repeat(32), scope: [], feeToken: '0x' + '00'.repeat(20), feeCap: '0', notBefore: m.notBefore, expires: m.expires, nonce: '1', subdelegate: false }),
  ]
  for (const o of others) assert.notEqual(sig.recoverAddress(o, s), user)
  assert.notEqual(sig.recoverAddress(g.grantDigest(56, HUB, m), rs), user)
  // another chain or hub: another hash / 换链、换 hub 即换哈希
  assert.notEqual(g.grantHashOf(8453, HUB, m), g.grantHashOf(56, HUB, m))
  assert.notEqual(g.grantHashOf(56, '0x' + '10'.repeat(20), m), g.grantHashOf(56, HUB, m))
  const ths = [g.VISITOR_GRANT_TYPEHASH, g.GRANT_REVOCATION_TYPEHASH, sig.DELEGATION_TYPEHASH, sig.VOUCHER_TYPEHASH, agent.MANDATE_TYPEHASH, agent.MANDATE_REVOCATION_TYPEHASH].map(toHex)
  assert.equal(new Set(ths).size, ths.length)
})

test('no money in the format: the types name no amount, token, cap or fee; the statement says "includes no payment"', () => {
  for (const t of [g.VISITOR_GRANT_TYPE, g.GRANT_REVOCATION_TYPE]) assert.doesNotMatch(t, /amount|token|\bcap\b|fee|price|value/i)
  assert.match(base().statement, /This grant includes no payment\./)
  assert.match(base({ lang: 'zh' }).statement, /本授权不含任何付款。/)
})

test('normalizeGrant: the bounds of the format (methods 1-8, no wildcard, maxCalls 1-10,000, life <= 7 days, notBefore <= now + 300, callerKey != user, canonical names, bytes32 nonce, exactly 14 members on the wire)', () => {
  const m = base()
  const nm = (o, opts) => g.normalizeGrant({ ...m, ...o }, opts)
  bad(() => nm({ methods: [] }), /1 to 8/)
  bad(() => nm({ methods: Array.from({ length: 9 }, (_, i) => `m${i}`) }), /1 to 8/)
  assert.equal(nm({ methods: Array.from({ length: 8 }, (_, i) => `m${i}`) }).methods.length, 8)
  bad(() => nm({ methods: ['a', 'a'] }), /repeats/)
  for (const x of ['*', 'a.b', '1a', '', 'a'.repeat(65), 'history*']) bad(() => nm({ methods: [x] }), /no wildcard/)
  for (const x of [0, 10_001, 1.5, '5', -1]) bad(() => nm({ maxCalls: x }), /maxCalls/)
  assert.equal(nm({ maxCalls: 10_000 }).maxCalls, 10_000)
  bad(() => nm({ expires: m.notBefore + 604_801 }), /7 days/)
  assert.equal(nm({ expires: m.notBefore + 604_800 }).expires, m.notBefore + 604_800)
  bad(() => nm({ expires: m.notBefore }), /after notBefore/)
  bad(() => base({ notBefore: NOW + 301, now: NOW }), /ahead/)
  assert.equal(base({ notBefore: NOW + 300 }).notBefore, NOW + 300)
  bad(() => nm({ callerKey: m.user }), /must not be the user/)
  bad(() => nm({ caller: '0x' + '00'.repeat(20) }), /zero/)
  for (const n of ['12.07.tape', '12.7.TAPE', '012.7.tape', '#12@7', 'tape://12.7.tape', '12.7']) bad(() => nm({ callerName: n }), /canonical/)
  for (const n of ['0x' + 'AB'.repeat(32), '0x' + '00'.repeat(32), '0x01']) bad(() => nm({ nonce: n }), /nonce/)
  bad(() => nm({ extra: 1 }, { wire: true }), /exactly the members/)
  const { nonce: _n, ...missing } = m
  bad(() => g.normalizeGrant(missing, { wire: true }), /exactly the members/)
  assert.equal(g.DEFAULT_GRANT_LIFE_S, 3600)
  assert.equal(m.expires - m.notBefore, 3600, 'SDK default: 1 hour')
})

test('statement: generated (en and zh, times in UTC, no address and no key), character for character; any change is a mismatch', () => {
  const m = base({ methods: ['history', 'quote_list'], maxCalls: 1 })
  assert.equal(m.statement, 'Allow 12.7.tape to call these methods of 13.7.tape on my behalf: history, quote_list. At most 1 call, valid from 2026-10-03 04:00:00 to 2026-10-03 05:00:00 UTC. This grant includes no payment. Revocable at any time with 13.7.tape.')
  const zh = base({ lang: 'zh' })
  assert.equal(zh.statement, '允许 12.7.tape 代表我调用 13.7.tape 的方法：history。最多 100 次，2026-10-03 04:00:00 至 2026-10-03 05:00:00 UTC 有效。本授权不含任何付款。可随时向 13.7.tape 撤销。')
  for (const s of [m.statement, zh.statement]) assert.doesNotMatch(s, /0x[0-9a-fA-F]{6}/)
  assert.equal(g.statementMatches(m), true)
  assert.equal(g.statementMatches(zh), true)
  for (const s of [m.statement + ' ', m.statement.replace('1 call', '1 calls'), m.statement.replace('04:00:00', '04:00'), zh.statement.replace('100', '10')]) assert.equal(g.statementMatches({ ...m, statement: s }), false)
  bad(() => g.renderStatement(m, 'fr'), /language/)
})

test('grantForWallet: the payload is rebuilt and compared (a member more or less, another domain, a statement that does not match, other names than the page resolved are refused); it holds only domain, types, primaryType, message', () => {
  const m = base()
  const td = g.grantTypedData(56, HUB, m)
  const expect = { chainId: 56, hub: HUB, callerName: '12.7.tape', audienceName: '13.7.tape' }
  const ok = g.grantForWallet(td, expect)
  assert.deepEqual(Object.keys(ok.payload).sort(), ['domain', 'message', 'primaryType', 'types'])
  assert.equal(ok.payload.types.VisitorGrant.map((f) => `${f.type} ${f.name}`).join(','), g.VISITOR_GRANT_TYPE.slice('VisitorGrant('.length, -1))
  bad(() => g.grantForWallet({ ...td, types: { ...td.types, VisitorGrant: [...td.types.VisitorGrant, { name: 'amount', type: 'uint256' }] } }, expect), /types differs/)
  bad(() => g.grantForWallet({ ...td, types: { ...td.types, VisitorGrant: td.types.VisitorGrant.slice(1) } }, expect), /types differs/)
  bad(() => g.grantForWallet({ ...td, message: { ...td.message, extra: 1 } }, expect), /message differs/)
  bad(() => g.grantForWallet({ ...td, domain: { ...td.domain, chainId: 1 } }, expect), /chain 1/)
  bad(() => g.grantForWallet({ ...td, domain: { ...td.domain, verifyingContract: '0x' + '10'.repeat(20) } }, expect), /verifyingContract/)
  bad(() => g.grantForWallet({ ...td, domain: { ...td.domain, name: 'TapeAPI' } }, expect), /never the TAP-11/)
  bad(() => g.grantForWallet({ ...td, message: { ...td.message, statement: td.message.statement.replace('100', '1') } }, expect), /statement/)
  bad(() => g.grantForWallet(td, { chainId: 56, hub: HUB }), /callerName and audienceName/)
  bad(() => g.grantForWallet(td, { ...expect, callerName: '4246.0.tape' }), /page expects/)
  bad(() => g.grantForWallet(td), /expects/)
})

test('the call proof: 140 bytes, its own prefix (not TAP-13\'s), binds audience, grant, id and the request hash; v 27/28, low s', () => {
  const m = base()
  const o = { audience: m.audience, grantHash: g.grantHashOf(56, HUB, m), id: 'c6f1', method: 'history', params: { limit: 1 }, ts: NOW }
  const pre = g.callProofPreimage(o)
  assert.equal(pre.length, 140)
  assert.equal(new TextDecoder().decode(pre.slice(0, 16)), 'TAPI-grant/call1')
  assert.notEqual(new TextDecoder().decode(pre.slice(0, 14)), sig.RESPONSE_DIGEST_PREFIX)
  assert.equal(toHex(pre.slice(100, 132)), sig.responseRequestHash({ method: 'history', params: { limit: 1 } }), 'the request hash is TAP-13 §5\'s')
  const p = g.signCallProof(o, CALLER_KEY)
  assert.equal(g.recoverCallProofSigner(o, p.sig), m.callerKey)
  for (const k of ['audience', 'grantHash', 'id', 'method', 'params', 'ts']) {
    const changed = { ...o, [k]: { audience: m.user, grantHash: '0x' + '22'.repeat(32), id: 'c6f2', method: 'quote', params: { limit: 2 }, ts: NOW + 1 }[k] }
    assert.notEqual(g.recoverCallProofSigner(changed, p.sig), m.callerKey, k)
  }
  const v01 = p.sig.slice(0, -2) + (parseInt(p.sig.slice(-2), 16) - 27).toString(16).padStart(2, '0')
  assert.equal(g.recoverCallProofSigner(o, v01), null, 'v 0/1 refused')
})

test('GrantRevocation: at most 24 hashes, exactly four members, something to revoke', () => {
  const user = sig.privateKeyToAddress(USER_KEY)
  bad(() => g.normalizeGrantRevocation({ user, grantHashes: Array(25).fill('0x' + '11'.repeat(32)), revokedBefore: 0, issued: NOW }), /24/)
  bad(() => g.normalizeGrantRevocation({ user, grantHashes: [], revokedBefore: 0, issued: NOW }), /list a grant hash/)
  bad(() => g.normalizeGrantRevocation({ user, grantHashes: [], revokedBefore: NOW, issued: NOW, x: 1 }), /exactly/)
  assert.equal(g.normalizeGrantRevocation({ user, grantHashes: [], revokedBefore: NOW, issued: NOW }).revokedBefore, NOW)
})

test('memoryGrantStore: reserve / commit / release, (hash, id) recorded only at commit, maxCalls counted with calls in flight, revocation by hash and by date', () => {
  let now = NOW
  const s = g.memoryGrantStore({ clock: () => now })
  const H = '0x' + '11'.repeat(32)
  const a = s.reserve(H, 'a', 2, NOW + 60)
  const b = s.reserve(H, 'b', 2, NOW + 60)
  assert.deepEqual([a.used, b.used], [1, 2])
  assert.equal(s.reserve(H, 'c', 2, NOW + 60), null, 'exhausted while two are in flight')
  assert.equal(s.reserve(H, 'a', 2, NOW + 60).replayed, true, 'the same id in flight')
  b.release()
  assert.equal(s.delivered(H, 'b'), false)
  a.commit()
  assert.equal(s.delivered(H, 'a'), true)
  assert.equal(s.usedOf(H), 1)
  const user = '0x' + 'aa'.repeat(20)
  s.revoke(user, [H])
  assert.equal(s.isRevoked(user.toUpperCase().replace('0X', '0x'), H, 0), true)
  s.revokeBefore(user, NOW)
  s.revokeBefore(user, NOW - 10)
  assert.equal(s.isRevoked(user, '0x' + '22'.repeat(32), NOW - 1), true)
  assert.equal(s.isRevoked(user, '0x' + '22'.repeat(32), NOW), false)
  now += 3600
  assert.equal(s.delivered(H, 'a'), true, 'pruned only on reserve')
})

// ---------- vectors / 向量 ----------
function buildVectors() {
  const user = sig.privateKeyToAddress(USER_KEY)
  const cases = [['en, one method', base()], ['zh, three methods, 7 days', base({ lang: 'zh', methods: ['history', 'notes', 'quote_list'], maxCalls: 10_000, lifeS: 604_800, nonce: '0x' + 'fe'.repeat(32) })]]
  const grants = cases.map(([name, m]) => ({
    name, message: m, methodsHash: toHex(keccak256(new Uint8Array(m.methods.flatMap((x) => [...keccak256(utf8ToBytes(x))])))),
    structHash: toHex(g.hashVisitorGrant(m)), digest: g.grantHashOf(56, HUB, m), userSig: g.signGrant(56, HUB, m, USER_KEY),
    statements: { en: g.renderStatement(m, 'en'), zh: g.renderStatement(m, 'zh') },
  }))
  const proofs = [['empty params', 'c6f1', {}], ['params bound', 'g-0001', { limit: 1, from: '2026-10-01' }]].map(([name, id, params]) => {
    const o = { audience: grants[0].message.audience, grantHash: grants[0].digest, id, method: 'history', params, ts: NOW + 7 }
    const digest = g.callProofDigest(o)
    return { name, ...o, preimage: toHex(g.callProofPreimage(o)), digest: toHex(digest), personalDigest: toHex(sig.personalDigest(digest)), sig: g.signCallProof(o, CALLER_KEY).sig }
  })
  const revocations = [['by hash', { user, grantHashes: [grants[0].digest, grants[1].digest], revokedBefore: 0, issued: NOW + 60 }], ['by date', { user, grantHashes: [], revokedBefore: NOW, issued: NOW + 60 }]].map(([name, r]) => ({
    name, revocation: r, structHash: toHex(g.hashGrantRevocation(r)), digest: toHex(g.grantRevocationDigest(56, HUB, r)), sig: g.signGrantRevocation(56, HUB, r, USER_KEY),
  }))
  return {
    // Frozen: the published vector file stays byte-identical, so its note still names the earlier subpath and test path
    // (@tapeapi/sdk/interop, sdk/test/interop.test.mjs); the code is now @tapeapi/interop, interop/test/interop.test.mjs.
    // 固定不改：已发布的向量文件须逐字节不变，所以 note 仍写旧的子路径与测试路径；代码现在是 @tapeapi/interop。
    note: 'Self-test vectors of the EXPERIMENTAL visitor-grant prototype (@tapeapi/sdk/interop). Not a specification, not a TAP, not a TAP\'s assets; no service knows this format. Fake keys (repeated bytes). Checked by sdk/test/interop.test.mjs (JS), spec/vectors/verify.py (Python) and contracts/test/VisitorGrantTypehash.t.sol (Solidity).',
    v: g.GRANT_FORMAT_VERSION,
    types: { VisitorGrant: g.VISITOR_GRANT_TYPE, GrantRevocation: g.GRANT_REVOCATION_TYPE },
    typeHashes: { VisitorGrant: toHex(g.VISITOR_GRANT_TYPEHASH), GrantRevocation: toHex(g.GRANT_REVOCATION_TYPEHASH) },
    domain: g.grantDomain(56, HUB), domainSeparator: g.grantDomainSeparator(56, HUB),
    otherChain: { chainId: 8453, domainSeparator: g.grantDomainSeparator(8453, HUB), digest: g.grantHashOf(8453, HUB, grants[0].message) },
    userKey: USER_KEY, userAddress: user, callerKey: CALLER_KEY, callerKeyAddress: sig.privateKeyToAddress(CALLER_KEY),
    callProofPrefix: g.CALL_PROOF_PREFIX, grants, proofs, revocations,
  }
}
const VEC = new URL('../../spec/vectors/interop-visitor-grant.json', import.meta.url)
test('spec/vectors/interop-visitor-grant.json: the SDK rebuilds every type hash, struct hash, digest, statement, call proof and signature (verify.py checks the same file independently)', () => {
  const want = buildVectors()
  if (process.env.TAPEAPI_WRITE_VECTORS === '1') writeFileSync(VEC, JSON.stringify(want, null, 2) + '\n')
  const v = JSON.parse(readFileSync(VEC, 'utf8'))
  assert.deepEqual(v, JSON.parse(JSON.stringify(want)))
  for (const c of v.grants) {
    assert.equal(sig.recoverAddress(c.digest, c.userSig), v.userAddress)
    assert.equal(c.message.statement, c.statements[c.name.startsWith('zh') ? 'zh' : 'en'])
    assert.equal(g.statementMatches(c.message), true)
  }
  for (const p of v.proofs) assert.equal(g.recoverCallProofSigner(p, p.sig), v.callerKeyAddress)
  for (const r of v.revocations) assert.equal(sig.recoverAddress(r.digest, r.sig), v.userAddress)
})

// CHANGED (3.0 candidate): the code is the package @tapeapi/interop, no longer an SDK subpath. Its modules import each
// other, @noble/hashes and the SDK's public entries only (the root and subpaths in its exports map, whose own graph the
// playground build checks); never an SDK file by path. / 代码现为独立包 @tapeapi/interop：模块只导入彼此、@noble/hashes 与 SDK 的公开入口。
const SDK_EXPORTS = JSON.parse(readFileSync(new URL('../../sdk/package.json', import.meta.url), 'utf8')).exports
test('the package is browser-plain: from interop-public.js, every module imports only its own files, @noble and the SDK\'s public entries, and uses no node:, Buffer or process', () => {
  const seen = new Set()
  const walk = (file) => {
    if (seen.has(file)) return
    seen.add(file)
    const code = readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8')
    const bare = code.replace(/\/\*[^]*?\*\/|\/\/[^\n]*/g, '')
    assert.doesNotMatch(bare, /from\s*['"]node:|\brequire\s*\(|\bBuffer\b|\bprocess\./, file)
    for (const s of importsOf(code)) {
      if (s.startsWith('./')) walk(s.slice(2))
      else if (s === '@tapeapi/sdk' || s.startsWith('@tapeapi/sdk/')) assert.ok(`.${s.slice('@tapeapi/sdk'.length)}` in SDK_EXPORTS || s === '@tapeapi/sdk', `${file} imports ${s}, which the SDK does not export`)
      else assert.match(s, /^@noble\/hashes\//, `${file} imports ${s}`)
    }
  }
  walk('interop-public.js')
  assert.ok(seen.has('interop-sig.js') && seen.has('interop-verify.js') && seen.has('interop-call.js'))
})

test('the declarations: every export of the package is declared in types/interop.d.ts and marked @experimental; nothing in the package root changed', async () => {
  const dts = readFileSync(new URL('../types/interop.d.ts', import.meta.url), 'utf8')
  const declared = new Map()
  const lines = dts.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const m = /^(?:\/\*\*.*?\*\/\s*)?export\s+declare\s+(?:function|const)\s+([A-Za-z_$][\w$]*)/.exec(lines[i])
    if (m) declared.set(m[1], /@experimental/.test(lines.slice(Math.max(0, i - 1), i + 1).join('\n')))
  }
  for (const name of Object.keys(g)) {
    assert.ok(declared.has(name), `${name} is declared`)
    assert.equal(declared.get(name), true, `${name} is @experimental`)
  }
  const root = await import('@tapeapi/sdk')
  for (const name of ['verifyVisitorGrant', 'withGrant', 'makeGrant', 'interop']) assert.equal(name in root, false, `the root does not export ${name}`)
  assert.equal('./interop' in SDK_EXPORTS, false, 'the SDK has no interop subpath')
})

// 2.x line: the reads verifyVisitorGrant needs, from a client made with no `conform` option (the 2.0 default, the TAP-10
// conformance mode), on the SDK's TAP-10 test chain. FIXED (2.x): they read the TAP-10 site status as the default
// resolution does, so a name the default `resolve` refuses (`unpaid`, `not-opened`) comes back with that status and the
// grant check refuses it (it used to read `latest` without opening or activation, and accept it).
// 2.x：默认客户端（一致模式）下的三个读链函数。已修复：按默认解析读 TAP-10 站点状态，默认 resolve 拒绝的名字带着该状态返回，由授权核验拒绝。
test('chainReadsFromApi on a 2.0 default client (TAP-10 test chain): names, holders and the TAP-10 site status; unpaid and not-opened as the default resolve says', async () => {
  const { createTapeAPI } = await import('@tapeapi/sdk')
  const { createConformChain } = await import('../../sdk/test/helpers/conform-chain.mjs')
  const RPC = ['http://rpc1', 'http://rpc2', 'http://rpc3']
  const chain = createConformChain(); chain.state.headTime = NOW
  const holder = sig.privateKeyToAddress('0x' + '5c'.repeat(32))
  const c = chain.circuit(42, { holder }); chain.setAccount('42', c.container); chain.setCode(c.container)
  const warnings = []
  const api = createTapeAPI({ rpcUrls: RPC, quorum: 2, clock: () => NOW, quiet: true, onWarning: (w) => warnings.push(w.code), fetch: (u, i) => chain.fetch(String(u), i) })
  const reads = g.chainReadsFromApi(api, { chainId: 56, clock: () => NOW })
  const lc = (a) => String(a).toLowerCase()
  const n = await reads.resolveName('42.7.tape')
  assert.equal(lc(n.container), lc(c.container)); assert.equal(lc(n.holder), lc(holder)); assert.equal(n.status, 'ok')
  const h = await reads.holderOf(c.container)
  assert.equal(lc(h.holder), lc(holder)); assert.equal(h.status, 'ok')
  assert.equal(await reads.resolveName('42.7.tape.example'), null)
  assert.equal(await reads.resolveName('42.7.tape'), n, 'cached for 60 s')
  assert.deepEqual(warnings.filter((w) => w === 'DEPRECATED'), [])
  // Not activated: the default resolve refuses it as unpaid; the reads say unpaid. / 未激活：默认 resolve 报 unpaid，读链同样。
  chain.setUnactivated()
  await assert.rejects(api.resolve('42.7.tape'), (e) => e.data?.status === 'unpaid')
  const fresh = g.chainReadsFromApi(api, { chainId: 56, clock: () => NOW })
  assert.equal((await fresh.resolveName('42.7.tape')).status, 'unpaid')
  assert.equal((await fresh.holderOf(c.container)).status, 'unpaid')
  // The check maps it to its own reasons, after the identity checks; uncounted. / 核验映射为自己的原因。
  const caller = { container: c.container, holder, status: 'unpaid' }
  const m = base({ caller: c.container, callerName: '42.7.tape', callerHolder: holder })
  const verify = (chainReads) => g.verifyVisitorGrant(g.wireGrant({ chainId: 56, message: m, userSig: sig.signDigest(g.grantDigest(56, HUB, m), USER_KEY), proof: g.signCallProof({ audience: m.audience, grantHash: g.grantHashOf(56, HUB, m), id: 'x1', method: 'history', params: {}, ts: NOW }, CALLER_KEY) }), {
    chainId: 56, hub: HUB, me: { container: m.audience, name: m.audienceName }, manifest: { methods: [{ name: 'history', grant: 'required' }] },
    method: 'history', id: 'x1', params: {}, voucherSent: false, now: NOW, store: g.memoryGrantStore({ clock: () => NOW }), chain: chainReads,
  })
  const okAudience = async () => ({ holder: m.audienceHolder, status: 'ok' })
  assert.equal((await verify({ holderOf: okAudience, resolveName: async () => caller })).reason, 'caller-unpaid')
  assert.equal((await verify({ holderOf: okAudience, resolveName: async () => ({ ...caller, status: 'not-opened' }) })).reason, 'caller-not-opened')
  assert.equal((await verify({ holderOf: async () => ({ holder: m.audienceHolder, status: 'unpaid' }), resolveName: async () => caller })).reason, 'audience-unpaid')
  assert.equal((await verify({ holderOf: async () => ({ holder: m.audienceHolder, status: 'not-opened' }), resolveName: async () => caller })).reason, 'audience-not-opened')
  // A holder that differs is reported first (identity before site status), as the default resolution orders them.
  assert.equal((await verify({ holderOf: async () => ({ holder: '0x' + '77'.repeat(20), status: 'unpaid' }), resolveName: async () => caller })).reason, 'audience-holder-changed')
  // A custom reader that reports no status vouches for ok (the address form of holderOf still works). / 不报告状态视为 ok。
  const ok = await verify({ holderOf: async () => m.audienceHolder, resolveName: async () => ({ container: c.container, holder }) })
  assert.equal(ok.ok, true, ok.reason)
  await assert.rejects(verify({ holderOf: okAudience, resolveName: async () => ({ ...caller, status: 'weird' }) }), /does not know/)
  for (const r of ['audience-not-opened', 'audience-unpaid', 'caller-not-opened', 'caller-unpaid']) assert.ok(g.GRANT_REASONS.includes(r), r)
  assert.ok(g.GRANT_REASONS.indexOf('caller-unpaid') > g.GRANT_REASONS.indexOf('caller-holder-changed'))
  // chainReadsFromApi needs a client that has siteStatus. / 需要带 siteStatus 的 SDK 客户端。
  assert.throws(() => g.chainReadsFromApi({ chain: {} }), /needs an SDK client/)
})

// FIXED G-2: revocations are bounded and dropped once they can refuse nothing; in memory only (lost on restart, said in
// the docs). / 撤销有上限，到期即清理；只在内存（重启丢失，文档写明）。
test('FIXED G-2: memoryGrantStore bounds its revocations: an expired one is dropped, a live one kept, revokedBefore dropped after 7 days, and a full store refuses (never drops) a new one', () => {
  let now = NOW
  const st = g.memoryGrantStore({ clock: () => now, maxRevocations: 3, maxUnseenRevocations: 3 })   // the unseen budget (IR-1) as large as the whole here / 这里让未见预算等于总量
  const U = '0x' + '3a'.repeat(20), h = (b) => '0x' + b.repeat(32)
  st.revoke(U, [h('01')], NOW + 100)                 // its grant expires at NOW + 100 / 授权到期时间已知
  st.revoke(U, [h('02')])                            // from grant_revoke: expiry unknown / 来自 grant_revoke：到期时间未知
  st.revokeBefore(U, NOW)
  assert.deepEqual(st.revocations(), { byHash: 2, before: 1, unseen: 1 })
  assert.throws(() => st.revoke(U, [h('03')]), (e) => e.code === 'INTERNAL' && /revocation store is full \(3 entries\)/.test(e.message))
  assert.equal(st.isRevoked(U, h('01'), NOW - 10, NOW + 100), true)
  // Re-revoking what is kept takes no room. / 重复撤销不占位置。
  st.revoke(U, [h('02')])
  // The grant of 01 expired (plus twice the skew): dropped, room again. / 01 的授权过期：清理，腾出位置。
  now = NOW + 100 + 2 * g.GRANT_SKEW_S + 1
  st.revoke(U, [h('03')])
  assert.deepEqual(st.revocations(), { byHash: 2, before: 1, unseen: 2 })
  assert.equal(st.isRevoked(U, h('01'), NOW, NOW + 100), false, 'its grant has expired anyway')
  assert.equal(st.isRevoked(U, h('02'), NOW, NOW + 9999), true, 'expiry unknown: kept')
  // Its expiry is learned when the grant is presented (the hash commits to it), then it is dropped after it. / 出现时得知到期时间。
  now = NOW + 9999 + 2 * g.GRANT_SKEW_S + 1 + 7 * 86400
  st.revoke(U, [h('04')], now + 50)
  assert.equal(st.isRevoked(U, h('02'), NOW, NOW + 9999), false, 'dropped once its grant expired')
  assert.equal(st.revocations().before, 0, 'revokedBefore dropped: every grant it refuses has expired')
  assert.equal(st.isRevoked(U, h('04'), now, now + 50), true, 'a live revocation is kept')
  assert.throws(() => g.memoryGrantStore({ maxRevocations: 0 }), /maxRevocations must be a positive integer/)
})

// FIXED G-4: the check reads no name and no holder before every cheap check and the visitor's signature have passed:
// a grant that fails them costs the service no chain read. / 廉价检查与用户签名全部成功之前不读名字、不读持有人。
test('FIXED G-4: a grant refused by a cheap check or by the visitor\'s signature costs no chain read; the service\'s holder is read after the signature (a stale audienceHolder with a bad signature is "bad-user-signature")', async () => {
  const m = base()
  const hash = g.grantHashOf(56, HUB, m)
  const reads = { holderOf: 0, resolveName: 0, isValidSignature: 0 }
  const chain = {
    holderOf: async () => { reads.holderOf++; return { holder: m.audienceHolder, status: 'ok' } },
    resolveName: async () => { reads.resolveName++; return { container: m.caller, holder: m.callerHolder, status: 'ok' } },
    isValidSignature: async () => { reads.isValidSignature++; return false },
  }
  const run = async ({ message = m, userSig, key = CALLER_KEY, id = 'r1', now = NOW, store = g.memoryGrantStore({ clock: () => now }) } = {}) => {
    const h = g.grantHashOf(56, HUB, message)
    const wire = g.wireGrant({ chainId: 56, message, userSig: userSig ?? sig.signDigest(g.grantDigest(56, HUB, message), USER_KEY), proof: g.signCallProof({ audience: message.audience, grantHash: h, id, method: 'history', params: {}, ts: now }, key) })
    return g.verifyVisitorGrant(wire, { chainId: 56, hub: HUB, me: { container: m.audience, name: m.audienceName }, manifest: { methods: [{ name: 'history', grant: 'required' }] }, method: 'history', id, params: {}, voucherSent: false, now, store, chain })
  }
  const delivered = g.memoryGrantStore({ clock: () => NOW })
  delivered.reserve(hash, 'r1', 5, m.expires).commit()
  const revoked = g.memoryGrantStore({ clock: () => NOW })
  revoked.revoke(m.user, [hash], m.expires)
  const cases = [
    ['expired', { now: m.expires }],
    ['statement-mismatch', { message: { ...m, statement: m.statement + ' ' } }],
    ['revoked', { store: revoked }],
    ['bad-proof', { key: USER_KEY }],
    ['replayed', { store: delivered }],
    ['bad-user-signature', { userSig: sig.signDigest(g.grantDigest(56, HUB, m), CALLER_KEY) }],
    ['bad-user-signature', { message: base({ audienceHolder: '0x' + '77'.repeat(20) }), userSig: '0x' + '11'.repeat(65) }],
  ]
  for (const [reason, o] of cases) assert.equal((await run(o)).reason, reason, reason)
  assert.deepEqual({ holderOf: reads.holderOf, resolveName: reads.resolveName }, { holderOf: 0, resolveName: 0 }, 'no name or holder was read for a grant refused before step 10')
  // the same stale holder with a good signature: now the holder is read, and it is refused for it / 签名有效时才读持有人
  assert.equal((await run({ message: base({ audienceHolder: '0x' + '77'.repeat(20) }) })).reason, 'audience-holder-changed')
  assert.deepEqual({ holderOf: reads.holderOf, resolveName: reads.resolveName }, { holderOf: 1, resolveName: 0 }, 'the service\'s holder is read before the caller\'s name')
  const ok = await run({ id: 'r2' })
  assert.equal(ok.ok, true, ok.reason)
  assert.deepEqual({ holderOf: reads.holderOf, resolveName: reads.resolveName }, { holderOf: 2, resolveName: 1 })
  // GRANT_REASONS keeps the order of the check / 拒绝原因按核验顺序排列
  const at = (r) => g.GRANT_REASONS.indexOf(r)
  for (const r of ['audience-holder-changed', 'audience-not-opened', 'audience-unpaid']) {
    assert.ok(at(r) > at('bad-user-signature') && at(r) < at('caller-name-mismatch'), r)
  }
  assert.ok(at('wrong-audience') < at('method-out-of-scope'))
})

// Step 13 of the design, the part the SDK can do: the rate-limit key grant:<caller>:<user> in the store (take), a
// sliding window, bounded. / 第 13 步里 SDK 能做的部分：限流键进存储（take），滑动窗口，有上限。
test('step 13 (rate-limit key): memoryGrantStore.take keeps a sliding window per key: refused past the limit with the wait, nothing counted when refused, the previous window weighs less as it slides out; keys are bounded', () => {
  let now = 6_000_000                                   // a multiple of 60: the start of a window / 窗口起点
  const st = g.memoryGrantStore({ clock: () => now, maxRateKeys: 2 })
  const K = 'grant:0xaa:0xbb'
  assert.deepEqual([st.take(K, 3, 60), st.take(K, 3, 60), st.take(K, 3, 60)], [0, 0, 0])
  assert.equal(st.take(K, 3, 60), 60, 'the 4th in the window waits for the next one')
  assert.equal(st.take('grant:0xaa:0xcc', 3, 60), 0, 'another visitor of the same caller has its own window')
  now += 60                                             // next window: the previous 3 weigh 3 x (1 - 0) = 3 / 下一个窗口起点：上一窗口全额计入
  assert.equal(st.take(K, 3, 60), 60)
  now += 30                                             // half way: 3 x 0.5 = 1.5, so one more fits (2.5 <= 3), not two
  assert.equal(st.take(K, 3, 60), 0)
  assert.equal(st.take(K, 3, 60), 30)
  now += 90                                             // two windows later: nothing left / 两个窗口之后清零
  assert.equal(st.take(K, 3, 60), 0)
  st.take('grant:0xaa:0xdd', 3, 60)
  assert.equal(st.rateKeys(), 2, 'bounded: the oldest key is dropped (it only forgets its count)')
  assert.throws(() => g.memoryGrantStore({ maxRateKeys: 0 }), /maxRateKeys must be a positive integer/)
  assert.ok(g.GRANT_REASONS.indexOf('rate-limited') > g.GRANT_REASONS.indexOf('voucher-not-allowed') && g.GRANT_REASONS.indexOf('rate-limited') < g.GRANT_REASONS.indexOf('exhausted'))
})

// FIXED G-3: the signed answers kept for a retry of the same id are bounded by count and by size, expire, and are found
// only under their own (hash, id). / 为同 id 重试保留的已签回答：按条数与大小设上限、会到期、只按自己的 (hash, id) 找到。
test('FIXED G-3: memoryGrantStore keeps signed answers by (hash, id) until `until`, bounded by maxAnswers and maxAnswerBytes (oldest dropped first; one too large is not kept); maxAnswers 0 keeps none', () => {
  let now = NOW
  const env = (n, size = 10) => Object.freeze({ id: `i${n}`, ok: true, result: { pad: 'x'.repeat(size) }, ts: now, sig: '0x' })
  const H1 = '0x' + '11'.repeat(32), H2 = '0x' + '22'.repeat(32)
  const st = g.memoryGrantStore({ clock: () => now, maxAnswers: 2, maxAnswerBytes: 4000 })
  assert.equal(st.keepAnswer(H1, 'i1', env(1), { until: now + 300, req: '0xaa' }), true)
  assert.deepEqual(st.answerOf(H1, 'i1'), { env: env(1), req: '0xaa' })
  assert.equal(st.answerOf(H2, 'i1'), null, 'another grant, same id: nothing')
  assert.equal(st.answerOf(H1, 'i2'), null)
  st.keepAnswer(H1, 'i2', env(2), { until: now + 300, req: '0xbb' })
  st.keepAnswer(H1, 'i3', env(3), { until: now + 300, req: '0xcc' })
  assert.equal(st.answers().count, 2)
  assert.equal(st.answerOf(H1, 'i1'), null, 'the oldest went first')
  assert.equal(st.keepAnswer(H1, 'i4', env(4, 3000), { until: now + 300, req: '0xdd' }), false, 'larger than maxAnswerBytes: not kept')
  st.keepAnswer(H1, 'i5', env(5, 1500), { until: now + 300, req: '0xee' })
  assert.ok(st.answers().bytes <= 4000)
  now += 301
  assert.equal(st.answerOf(H1, 'i5'), null, 'expired')
  const none = g.memoryGrantStore({ clock: () => now, maxAnswers: 0 })
  assert.equal(none.keepAnswer(H1, 'i1', env(1), { until: now + 300, req: '0xaa' }), false)
  assert.throws(() => g.memoryGrantStore({ maxAnswers: -1 }), /maxAnswers must be a non-negative integer/)
  assert.equal(g.GRANT_ANSWER_KEEP_S, 300)
})
