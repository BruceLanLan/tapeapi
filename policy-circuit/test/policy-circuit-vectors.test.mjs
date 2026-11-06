// Every case of the Policy Circuit Gate draft's vectors (TAPs pull request #84, head 0b73174), the constants and digests
// outside the 188 cases, the subjects, and the SDK signer reproducing a vector signature byte for byte. The vector file is
// a copy pinned by SHA-256: a different file fails here instead of being taken.
// The same file is checked twice more: spec/vectors/verify.py (types, domain, binding and revocation digests, signers)
// and contracts/test/PolicyBindingTypehash.t.sol (the type hashes, the domain, one binding, two revocations, in Solidity).
// 草稿向量的每一例（TAPs PR #84，头 0b73174）、188 例之外的常量与摘要、主体，以及 SDK 签名器逐字节复现向量签名。向量文件是按
// SHA-256 钉住的副本：文件不同就在这里失败，而不是被悄悄接受。
// 同一文件另外两方核对：spec/vectors/verify.py（Python）与 contracts/test/PolicyBindingTypehash.t.sol（Solidity）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { signDigest } from '@tapeapi/sdk/sig'
import { CHAINS } from '@tapeapi/sdk/chains'
import * as pc from '@tapeapi/policy-circuit'
import { parseLossless, checkPolicyBindingTrustingGivenSigners } from './policy-circuit-helpers.mjs'

const HERE = new URL('./vectors/', import.meta.url)
const VECTORS_SHA256 = '8a4659d8f157fdad7b4ebe9b6bc08d946f9f55b8ab688e3804bfe33b9970acd6'
const sha = (b) => createHash('sha256').update(b).digest('hex')
const text = readFileSync(new URL('vectors.json', HERE))
const v = parseLossless(text.toString('utf8'))
const fx = JSON.parse(readFileSync(new URL('./policy-circuit-fixtures.json', import.meta.url), 'utf8'))
const fromHex = (s) => Uint8Array.from(Buffer.from(s.replace(/^0x/, ''), 'hex'))
const toHex = (b) => '0x' + Buffer.from(b).toString('hex')
const file = (name) => new Uint8Array(readFileSync(new URL(v.policies[name].file, HERE)))
const TABLES = v.tables.tables
const TABLES_BY_NAME = { tables: TABLES, tablesUnitB: v.tablesUnitB.tables, tablesSharedClass: v.tablesSharedClass.tables }
const tally = {}
const outOfBand = { policyCheckFile: 0, bindingFile: 0, bindingTables: 0, bindingNow: 0 }
const outcome = (fn) => { try { return { result: fn() } } catch (e) { if (e instanceof pc.PolicyCircuitError) return { error: e.code }; throw e } }
// The expected shape: `error`, or `result` compared on the members the draft's reference returns (TapeAPI adds `display`).
// 期望：error，或按草稿参考实现返回的成员比对 result（TapeAPI 另加 display）。
const pick = (got, want) => (want && typeof want === 'object' && !Array.isArray(want) && got && typeof got === 'object' ? Object.fromEntries(Object.keys(want).map((k) => [k, got[k]])) : got)
function expectCase(section, c, got) {
  tally[section] = (tally[section] ?? 0) + 1
  if (c.error !== undefined && c.error !== null) assert.deepEqual(got, { error: c.error }, `${section} / ${c.name}`)
  else { assert.ok(!('error' in got), `${section} / ${c.name}: unexpected ${got.error}`); assert.deepEqual(pick(got.result, c.result), c.result, `${section} / ${c.name}`) }
}

test('the vector file is the pinned copy (SHA-256), and the vendored reference files match its digests', () => {
  assert.equal(sha(text), VECTORS_SHA256, 'test/vectors/vectors.json is not the copy of PR #84 at 0b73174: re-mirror on purpose, never update this pin silently')
  assert.equal(v.format, 'tap-draft-policy-circuit-gate/vectors/1')
  for (const f of ['tapnft.py', 'tap02_reference.py']) assert.equal(sha(readFileSync(new URL(`reference/${f}`, HERE))), v.vendored[f], f)
  for (const [n, p] of Object.entries(v.policies)) assert.equal('0x' + sha(file(n)), p.sha256, n)
})

test('F3: a plain JSON.parse loses the two 2^64 timestamps; the lossless read keeps them, and an unsafe JS number is refused', () => {
  const plain = JSON.parse(text.toString('utf8'))
  assert.notEqual(BigInt(plain.encoding[17].request.ts), 2n ** 64n - 1n, 'JSON.parse rounds it')
  assert.equal(v.encoding[22].request.ts, '18446744073709551615')
  const r = { ...v.encoding[22].request }
  for (const form of [r.ts, BigInt(r.ts)]) assert.deepEqual(pc.policyRequestFields({ ...r, ts: form }, TABLES), v.encoding[22].fields)
  assert.throws(() => pc.policyRequestWord({ ...r, ts: Number(r.ts) }, TABLES), (e) => e.code === 'request-malformed')
  const small = v.encoding[0].request
  for (const form of [small.amount, BigInt(small.amount), Number(small.amount)]) assert.deepEqual(pc.policyRequestWord({ ...small, amount: form }, TABLES), fromHex(v.encoding[0].word))
  assert.throws(() => pc.policyRequestWord({ ...small, amount: 2 ** 60 }, TABLES), (e) => e.code === 'request-malformed', 'an unsafe number is refused, never rounded')
})

test('policyChecks: one rejected file per rule of §2.2 and the stateful declaration both ways', () => {
  const tooLarge = () => {
    const recs = new Uint8Array(7100 * 7)
    for (let k = 0, prev = 129; k < 7100; k++, prev++) { const o = 7 * k; for (const off of [1, 4]) { recs[o + off] = prev >> 16; recs[o + off + 1] = (prev >> 8) & 255; recs[o + off + 2] = prev & 255 } }
    const out = new Uint8Array(16 + recs.length)
    out.set([0x54, 0x41, 0x50, 0x4e, 0x45, 0x54, 1, 0, 0, 0, 0, 128, 0, 0, 0, 8]); out.set(recs, 16)
    return out
  }
  for (const c of v.policyChecks) {
    let d
    if (c.hex) d = fromHex(c.hex)
    else {
      const src = fx.policyCheckFile[c.name]
      assert.ok(src, `${c.name}: no side fixture`)
      d = src === 'tooLargeGenerator' ? tooLarge() : file(src)
      outOfBand.policyCheckFile++
    }
    assert.equal('0x' + sha(d), c.sha256, `${c.name}: the fixture's SHA-256`)
    const got = outcome(() => { const i = pc.checkPolicyCircuit(d, { declaredStateful: c.declaredStateful ?? null }); return { nIn: i.nIn, nOut: i.nOut, nand: i.nand, latch: i.latch, gates: i.nand + i.latch, stateful: i.stateful, bytes: i.bytes, convention: pc.POLICY_CONVENTION } })
    expectCase('policyChecks', c, got)
  }
})

test('results: eleven output bytes (§2.3, fail closed)', () => {
  for (const r of v.results) {
    const { outputs, ...exp } = r
    tally.results = (tally.results ?? 0) + 1
    assert.deepEqual(pc.interpretPolicyOutput(fromHex(outputs)), exp, outputs)
  }
})

test('encoding, encodingErrors, tablesErrors, wordDecode (§3)', () => {
  for (const e of v.encoding) {
    tally.encoding = (tally.encoding ?? 0) + 1
    assert.deepEqual(pc.policyRequestFields(e.request, TABLES), e.fields, e.name)
    const w = pc.policyRequestWord(e.request, TABLES)
    assert.equal(toHex(w), e.word, e.name)
    assert.equal(BigInt('0x' + Buffer.from(w).reverse().toString('hex')), BigInt(e.wordInt), `${e.name}: the word as an integer`)
    assert.deepEqual(pc.decodePolicyWord(w), e.fields, `${e.name}: decodes back`)
  }
  for (const e of v.encodingErrors) expectCase('encodingErrors', e, outcome(() => pc.policyRequestWord(e.request, TABLES)))
  for (const e of v.tablesErrors) expectCase('tablesErrors', e, outcome(() => pc.policyTablesHash(e.tables)))
  for (const e of v.wordDecode) expectCase('wordDecode', { ...e, name: e.word }, outcome(() => pc.decodePolicyWord(fromHex(e.word))))
})

const loaded = Object.fromEntries(Object.keys(v.policies).map((n) => [n, pc.loadPolicyCircuit(file(n))]))
test('evaluations: 34 single requests (§4.1) and perAssetUnits: 7 under the two other tables, including evalFile on a stateful policy', () => {
  for (const e of [...v.evaluations, ...v.perAssetUnits]) {
    const section = e.tables ? 'perAssetUnits' : 'evaluations'
    const tables = e.tables ? TABLES_BY_NAME[e.tables] : TABLES
    assert.ok(tables, `${e.name}: unknown tables ${e.tables}`)
    if (e.error) { expectCase(section, e, outcome(() => pc.evalPolicyFile(loaded[e.policy], e.request, tables))); continue }
    const { policy, name, request, state, tables: tn, ...exp } = e
    tally[section] = (tally[section] ?? 0) + 1
    if (exp.fields) { assert.deepEqual(pc.policyRequestFields(request, tables), exp.fields, `${name}: fields`); delete exp.fields }
    assert.deepEqual(pc.evaluatePolicyRequest(loaded[policy], request, tables, state ? fromHex(state) : null), exp, name)
  }
})

test('traces: fifteen replays (§4.2)', () => {
  for (const t of v.traces) expectCase('traces', t, outcome(() => pc.replayPolicyTrace(loaded[t.policy], TABLES, t.entries, { notBefore: t.notBefore ?? null, expires: t.expires ?? null, escrowCumulative: !!t.escrowCumulative })))
})

// The binding vectors were made by a reference that takes each revocation's signer AS GIVEN (F2): replaying them needs
// that rule, which lives in the test helpers only (checkPolicyBindingTrustingGivenSigners). Run with the package's own
// check below: only "revoked by time" changes (it carries no signature).
// 绑定向量由"信任给定撤销签名者"的参考实现生成（F2）：复现需要这种规则，它只在测试辅助函数里。下面另用本包自己的检查跑：只有"revoked by time"改变（它没有签名）。
const bindingArgs = (b, extra = {}) => {
  const src = fx.bindingPolicyFile[b.name]
  const policyFile = src === undefined ? null : src.startsWith('policyChecks:') ? fromHex(v.policyChecks.find((c) => c.name === src.slice(13)).hex) : file(src)
  const named = fx.bindingTables[b.name]
  const tables = typeof named === 'string' ? TABLES_BY_NAME[named] : named ?? TABLES
  return [b.chainId, b.binding, b.sig, tables, { now: b.now ?? fx.bindingNow, policyFile, binder: b.expectedSigner ?? null, declaredStateful: b.declaredStateful ?? null, revocations: b.revocations ?? null, ...extra }]
}
test('bindings: 36 checks (§5.2, §5.3), the draft\'s revocation mode', () => {
  for (const b of v.bindings) {
    if (fx.bindingPolicyFile[b.name]) outOfBand.bindingFile++
    if (fx.bindingTables[b.name]) outOfBand.bindingTables++
    if (b.now === undefined) outOfBand.bindingNow++
    expectCase('bindings', b, outcome(() => checkPolicyBindingTrustingGivenSigners(...bindingArgs(b))))
  }
})
test('F2: with the default (signer recovered), only the unsigned "revoked by time" revocation stops applying', () => {
  const changed = []
  for (const b of v.bindings.filter((x) => x.revocations)) {
    const got = pc.checkPolicyBinding(...bindingArgs(b))
    if (JSON.stringify(got.problems) !== JSON.stringify(b.result.problems)) changed.push([b.name, got.problems])
  }
  assert.deepEqual(changed, [['revoked by time', []]])
})
test('F2: the package has no option that trusts a given revocation signer (test-only rule)', async () => {
  for (const b of v.bindings.filter((x) => x.revocations)) {
    const [c, binding, sig, tables, opts] = bindingArgs(b)
    const plain = pc.checkPolicyBinding(c, binding, sig, tables, opts)
    assert.deepEqual(pc.checkPolicyBinding(c, binding, sig, tables, { ...opts, trustGivenRevocationSigner: true }), plain, `${b.name}: the old option is ignored`)
  }
  assert.ok(!Object.keys(pc).some((n) => /trust|WithSigners/i.test(n)), 'nothing of the kind is exported')
  // the specifier is joined so that the documented-imports scan of scripts/packages.test.mjs does not take it for a use / 拼接写法，免得被当作文档里的导入
  const deep = ['@tapeapi', 'policy-circuit', 'src', 'policy-binding.js'].join('/')
  await assert.rejects(import(deep), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' }, 'the internal core is not reachable by a deep import')
})

test('revocations, tokenMetadata, subjectMetadata (§5.4, §6)', () => {
  const issued = v.bindings[0].binding.issued
  for (const r of v.revocations) {
    if ('error' in r) { expectCase('revocations', r, outcome(() => pc.policyRevocationCovers(r.revocation, v.bindingHashes.mandate, issued))); continue }
    tally.revocations = (tally.revocations ?? 0) + 1
    assert.equal(pc.policyRevocationCovers(r.revocation, v.bindingHashes.mandate, issued), r.covers, r.name)
    if (r.hash) assert.equal(pc.policyRevocationHash(56, r.revocation), r.hash, `${r.name}: hash`)
  }
  for (const t of v.tokenMetadata) expectCase('tokenMetadata', t, outcome(() => pc.checkTokenPolicyMember(t.tap)))
  // F4: a passing subject member is recorded as the string "ok" / 形式检查无误的成员记为字符串 "ok"
  for (const m of v.subjectMetadata) expectCase('subjectMetadata', m, outcome(() => { pc.checkSubjectPolicyMember(m.member); return 'ok' }))
})

test('the 25 checks outside the cases: constants, the five examples, binding hashes, subjects, the SDK signer', () => {
  let n = 0
  const eq = (a, b, what) => { assert.equal(a, b, what); n++ }
  eq(pc.POLICY_BINDING_TYPEHASH, v.constants.bindingTypehash, 'bindingTypehash')
  eq(pc.POLICY_REVOCATION_TYPEHASH, v.constants.revocationTypehash, 'revocationTypehash')
  for (const [c, s] of Object.entries(v.constants.domainSeparator)) eq(pc.policyDomainSeparator(Number(c)), s, `domainSeparator ${c}`)
  eq(pc.policyTablesHash(TABLES), v.tables.tablesHash, 'tablesHash')
  for (const [name, p] of Object.entries(v.policies)) {
    const i = pc.checkPolicyCircuit(file(name))
    assert.deepEqual([i.netlistHash, i.nand, i.latch, i.bytes, i.stateful, i.stateBytes], [p.sha256, p.nand, p.latch, p.bytes, p.stateful, p.stateBytes], name); n++
  }
  eq(pc.policyTablesHash(v.tablesUnitB.tables), v.tablesUnitB.tablesHash, 'tablesHash, the other unit of asset 2')
  eq(pc.policyTablesHash(v.tablesSharedClass.tables), v.tablesSharedClass.tablesHash, 'tablesHash, two assets sharing a class')
  // unitsChangeIdentity: tables that differ in one unit only are another binding (another tablesHash, binding hash and word)
  // 只差一个单位的表是另一个绑定（表哈希、绑定哈希、请求字都不同）
  const u = v.unitsChangeIdentity, ureq = v.perAssetUnits[0].request
  assert.equal(u.differ, true)
  ;[TABLES, v.tablesUnitB.tables].forEach((t, i) => {
    eq(pc.policyTablesHash(t), u.tablesHash[i], `unitsChangeIdentity tablesHash ${i}`)
    eq(pc.policyBindingHash(56, { ...v.bindings[0].binding, tablesHash: u.tablesHash[i] }), u.bindingHash[i], `unitsChangeIdentity bindingHash ${i}`)
    eq(toHex(pc.policyRequestWord(ureq, t)), u.word[i], `unitsChangeIdentity word ${i}`)
  })
  eq(pc.policyBindingHash(56, v.bindings[0].binding), v.bindingHashes.mandate, 'binding hash on 56')
  eq(pc.policyBindingHash(97, v.bindings[0].binding), v.bindingHashes.mandateOnChain97, 'binding hash on 97')
  eq(pc.policySubject.account(v.subjects.account.account).subject, v.subjects.account.subject, 'account subject')
  eq(pc.policySubject.label(v.subjects.label.label).subject, v.subjects.label.subject, 'label subject')
  const s = v.subjects.escrowSession
  eq(pc.policySubject.escrowSession(s).subject, s.subject, 'escrow-session subject')
  // RFC 6979: the SDK's signDigest with published test key 1 gives the vector's signature byte for byte
  // RFC 6979：SDK 的 signDigest 用公开测试钥匙 1 签出的签名与向量逐字节相同
  eq(signDigest(pc.policyBindingHash(56, v.bindings[0].binding), v.keys['1'].priv), v.bindings[0].sig, 'SDK signature = vector signature')
  assert.equal(n, 25)
  // the domain is TAP-11's: the hub is the SDK's / 域就是 TAP-11 的：中枢与 SDK 的相同
  assert.equal(pc.POLICY_HUB, CHAINS[56].hub)
  assert.equal(pc.POLICY_HUB.toLowerCase(), v.constants.domain.verifyingContract.toLowerCase())
})

test('every one of the 188 cases ran, section by section', () => {
  const sections = Object.keys(v.caseCount).filter((k) => k !== 'total')
  for (const s of sections) assert.equal(tally[s], v.caseCount[s], `${s}: ran ${tally[s]} of ${v.caseCount[s]}`)
  const total = sections.reduce((a, s) => a + tally[s], 0)
  assert.equal(total, v.caseCount.total)
  console.log(`# policy-circuit vectors: ${total}/${v.caseCount.total} cases; side fixtures used: policy files for policyChecks ${outOfBand.policyCheckFile}, binding policy files ${outOfBand.bindingFile}, binding tables ${outOfBand.bindingTables}, default now ${outOfBand.bindingNow} of ${v.bindings.length}`)
})
