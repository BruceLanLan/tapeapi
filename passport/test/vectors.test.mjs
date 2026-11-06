// The draft's own vectors (TAPs pull request #83 at head cae25e6, assets/tap-draft-agent-passport/vectors.json), vendored
// byte for byte under test/fixtures/ and pinned by SHA-256, replayed against the pure layer exactly as the draft's
// test_passport.py replays them against passport.py: 147 cases. TapeAPI's own extra cases are in
// passport-tapeapi-extra.test.mjs, never mixed into this file.
// 草案自己的向量（PR #83 头 cae25e6），逐字节放在 test/fixtures/ 并按 SHA-256 钉住，按草案 test_passport.py 的方式回放：147 例。
// TapeAPI 自己补的用例在 passport-tapeapi-extra.test.mjs，绝不混入本文件。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import * as P from '../src/passport-core.js'
import { DISPLAY_FORBIDDEN } from '../src/passport-text.js'
import { summariseFeedbackFromSnapshot, feedbackParams, reviewFileKey } from '../src/passport-feedback.js'

const RAW = readFileSync(new URL('./fixtures/vectors.json', import.meta.url))
const V = JSON.parse(RAW.toString('utf8'))
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const tally = {}
const seen = (sec, ok) => { tally[sec] ??= { pass: 0, fail: 0 }; tally[sec][ok ? 'pass' : 'fail']++ }

test('fixture: vectors.json is the draft file at the pinned SHA-256, format tap-agent-passport-vectors/1, 147 cases', () => {
  assert.equal(createHash('sha256').update(RAW).digest('hex'), P.DRAFT.vectorsSha256)
  assert.equal(P.DRAFT.head, 'cae25e6df54ad2e2e38e185304de55f92792966d')
  assert.equal(V.format, 'tap-agent-passport-vectors/1')
  assert.equal(V.counts.total, 147)
  const sum = Object.entries(V.counts).filter(([k]) => k !== 'total').reduce((n, [, v]) => n + v, 0)
  assert.equal(sum, 147)
  for (const [k, n] of Object.entries(V.counts)) if (k !== 'total') assert.equal(V[k].length, n, k)
})

test('resolution: 73 snapshots give the expected state, reason, warnings, display (en) and agentId', async () => {
  for (const c of V.resolution) {
    const snap = c.snapshot; const e = c.expected
    const res = await P.resolve(P.snapshotReads(snap), snap.input, snap.config)
    const why = []
    if (res.state !== e.state) why.push(`state ${res.state} != ${e.state}`)
    if (!eq(res.reasons, e.reasons)) why.push(`reasons ${JSON.stringify(res.reasons)}`)
    if ('warnings' in e && !eq(res.warnings, e.warnings)) why.push(`warnings ${JSON.stringify(res.warnings)}`)
    if ('display' in e && res.display.en !== e.display) why.push(`display ${res.display.en}`)
    if ('agentId' in e && !eq(res.agentId, e.agentId)) why.push(`agentId ${JSON.stringify(res.agentId)}`)
    if (!P.STATES.includes(res.state)) why.push('unknown state')
    for (const r of res.reasons) if (!(r in P.REASONS)) why.push(`unknown reason ${r}`)
    for (const w of res.warnings) if (!P.WARNINGS.includes(w)) why.push(`unknown warning ${w}`)
    for (const t of [res.display.en.toLowerCase(), res.display.zh]) for (const bad of DISPLAY_FORBIDDEN) if (t.includes(bad)) why.push(`display says ${bad}`)
    assert.equal(res.draft.head, P.DRAFT.head); assert.equal(res.experimental, true)
    seen('resolution', why.length === 0)
    assert.deepEqual(why, [], c.id)
  }
  assert.equal(tally.resolution.pass, 73)
})

test('UNAVAILABLE is only ever a P-6 reason (never BROKEN because of a node)', () => {
  for (const c of V.resolution) if (c.expected.state === 'UNAVAILABLE') for (const r of c.expected.reasons) assert.equal(P.REASONS[r], 'P-6', c.id)
})

test('passportKey (10), forbiddenNames (20), canonicalJson (4), runtimeCalls (12), delegationProposals (6)', () => {
  for (const c of V.passportKey) {
    let got
    try { const d = P.decodeKey(P.unhex(c.bytes)); got = { ok: true, chainId: d.chainId, processor: d.processor, tokenId: Number(d.tokenId) } }
    catch (e) { if (!(e instanceof P.Broken)) throw e; got = { ok: false, reason: e.reason } }
    seen('passportKey', eq(got, c.expected)); assert.deepEqual(got, c.expected, c.id)
  }
  for (const c of V.forbiddenNames) { const got = P.forbiddenName(c.name); seen('forbiddenNames', got === c.expected.forbidden); assert.equal(got, c.expected.forbidden, c.name) }
  for (const c of V.canonicalJson) { const got = P.canonicalJson(c.value); seen('canonicalJson', got === c.expected); assert.equal(got, c.expected) }
  for (const c of V.runtimeCalls) { const got = P.checkRuntimeCall(c.config, c.to, c.data, c.fromCounterpartyText).allowed; seen('runtimeCalls', got === c.expected.allowed); assert.equal(got, c.expected.allowed, c.id) }
  for (const c of V.delegationProposals) { const got = P.checkDelegationProposal(c.now, c.expires, c.isDefault, c.signerGeneratedHere).ok; seen('delegationProposals', got === c.expected.ok); assert.equal(got, c.expected.ok, c.id) }
})

test('feedback (21, §10, conditional on #54) and feedbackParams (1)', async () => {
  for (const c of V.feedback) {
    const snap = c.snapshot; const e = c.expected
    const res = await P.resolve(P.snapshotReads(snap), snap.input, snap.config)
    const rep = await summariseFeedbackFromSnapshot(snap, res)
    const why = []
    if (res.state !== e.state) why.push(`state ${res.state}`)
    if (e.computed === false) { if (rep.computed !== false || rep.why !== e.why) why.push(`computed/why ${rep.computed}/${rep.why}`) }
    else {
      for (const k of ['counted', 'excluded', 'getSummaryClientAddresses', 'outsideClientSet', 'earlierHolders']) if (!eq(rep[k], e[k])) why.push(`${k} ${JSON.stringify(rep[k])}`)
      const named = new Set(snap.summary.clientAddresses.map((x) => x.toLowerCase()))
      for (const a of rep.getSummaryClientAddresses || []) if (!named.has(a)) why.push('getSummary address outside the named set')
      if ('level-1' in e && !eq(rep.summary['level-1'], e['level-1'])) why.push('level-1')
    }
    seen('feedback', why.length === 0); assert.deepEqual(why, [], c.id)
  }
  for (const c of V.feedbackParams) {
    const p = feedbackParams(c.record, c.agentId, c.reviewerName, c.gatewayDomain, c.level)
    const sorted = (o) => Object.fromEntries(Object.entries(o).sort())
    const ok = eq(sorted(p), sorted(c.expected)) && p.feedbackURI.endsWith('/' + reviewFileKey(c.reviewHash))
    seen('feedbackParams', ok); assert.ok(ok, JSON.stringify(p).slice(0, 300))
  }
})

test('interfaces and constants: every selector and event hash the draft names, the confusable table exactly', () => {
  for (const s of V.interfaces.selectors) assert.equal(P.selector(s.signature), s.selector, s.signature)
  for (const h of V.interfaces.hashes) assert.equal(P.hx(P.keccak256(new TextEncoder().encode(h.text))), h.keccak256, h.text)
  const want = Object.fromEntries(Object.entries(V.constants.confusables).map(([k, v]) => [String.fromCodePoint(parseInt(k.slice(2), 16)), v]))
  assert.deepEqual(Object.fromEntries(Object.entries(P.CONFUSABLES).sort()), Object.fromEntries(Object.entries(want).sort()))
  assert.equal(P.forbiddenName('ᴘoints'), false, 'U+1D18 is outside the table')
  assert.equal(V.constants.registrationKey, P.REGISTRATION_KEY)
  assert.equal(V.constants.registrationType, P.REGISTRATION_TYPE)
  assert.equal(V.constants.passportKeyName, P.PASSPORT_KEY)
})

test('rule coverage: every machine-checkable rule of the draft has a vector (as test_passport.py)', () => {
  const MACHINE_RULES = ['P-1', 'P-2', 'P-3', 'P-4', 'P-5', 'P-6', 'P-7', 'P-8', 'P-9', 'P-10', 'P-11', 'R-1', 'R-2', 'R-3', 'R-4', 'R-5', 'E-1', 'E-2',
    'F-0', 'F-1', 'F-2', 'F-3', 'F-4', 'F-5', 'F-6', 'F-7', 'F-8', 'F-9', 'F-10', 'W-1', 'W-2', 'W-3', 'W-4', 'D-1', 'D-2', 'D-3', 'D-4', 'D-5', 'D-6']
  const covered = new Set()
  for (const sec of ['resolution', 'feedback', 'feedbackParams', 'passportKey', 'forbiddenNames', 'canonicalJson', 'runtimeCalls', 'delegationProposals']) for (const c of V[sec]) for (const r of c.rules) covered.add(r)
  assert.deepEqual(MACHINE_RULES.filter((r) => !covered.has(r)), [])
})

test('the key round-trips (§4); the tally is 147 of 147', () => {
  const b = P.encodePassportKey(56, '0x50a994e71615474b55559ff4f500928fbc339dd9', 4246n)
  assert.equal(b.length, 96)
  assert.deepEqual(P.decodeKey(b), { chainId: 56, processor: '0x50a994e71615474b55559ff4f500928fbc339dd9', tokenId: 4246n })
  const total = Object.values(tally).reduce((n, t) => n + t.pass, 0)
  const failed = Object.values(tally).reduce((n, t) => n + t.fail, 0)
  assert.equal(failed, 0)
  assert.equal(total, 147, JSON.stringify(tally))
})
