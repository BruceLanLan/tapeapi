// TapeAPI-local cases, NOT the draft's vectors (those are vectors.test.mjs): the gaps the prototype found on 2026-10-28
// (capital look-alikes, code points above U+FFFF, decimal literals in a registration file), the reference's own
// robustness checks, and the package's browser-safety. Every expected value here was checked against passport.py
// (cae25e6) when written; see test/helpers/extra-cases.mjs.
// TapeAPI 自己的用例，不是草案向量：原型发现的缺口、参考实现自带的健壮性检查、包的浏览器可用性。预期值写入时已用 passport.py 核对。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import * as P from '../src/passport-core.js'
import { EXTRA_NAMES, extraResolutionCases } from './helpers/extra-cases.mjs'

test('tapeapi-extra: capital Cyrillic / Greek look-alikes map through lower case; code points above U+FFFF split segments', () => {
  for (const [name, forbidden] of EXTRA_NAMES) assert.equal(P.forbiddenName(name), forbidden, JSON.stringify(name))
})

test('tapeapi-extra: 56 and 56.0 are different (tap.chainId 56.0 invalid, agentId 1001.0 not listed, v 1.0 accepted as the reference does)', async () => {
  const cases = extraResolutionCases()
  assert.equal(cases.length, 6)
  for (const c of cases) {
    const r = await P.resolve(P.snapshotReads(c.snapshot), c.snapshot.input, c.snapshot.config)
    assert.deepEqual({ state: r.state, reasons: r.reasons }, c.expected, c.id)
  }
  // Why a parser of our own: JSON.parse cannot tell them apart. / 为什么自写解析器：JSON.parse 分不出两者。
  assert.equal(JSON.parse('56.0'), JSON.parse('56'))
  const doc = P.strictJson(new TextEncoder().encode('{"a":56,"b":56.0,"c":5.6e1}'))
  assert.equal(doc.a, 56); assert.ok(doc.b instanceof P.JFloat); assert.ok(doc.c instanceof P.JFloat)
  assert.equal(P.canonicalJson(doc), '{"a":56,"b":56,"c":56}')
})

test("tapeapi-extra: the reference's robustness cases (no canonical form; ES number forms)", () => {
  const enc = (s) => new TextEncoder().encode(s)
  for (const bad of ['{"a":1,"a":2}', '{"__proto__":1}', '{"n":-0}', '{"n":9007199254740992}', '{"n":NaN}', '{"s":"\\ud800"}', '{"n":1e400}', '{"n":-0.0}', '{"constructor":{}}']) {
    assert.throws(() => P.canonicalJson(P.strictJson(enc(bad))), (e) => e instanceof P.NoCanonicalForm, bad)
  }
  for (const bad of ['\ufeff{}', '{"a":1,}', '{a:1}', "{'a':1}", '[1 2]', '{"a":"\u0001"}', '01', '1.', '.5', '{"a":1}x']) {
    assert.throws(() => P.strictJson(enc(bad)), (e) => e instanceof SyntaxError || e instanceof P.NoCanonicalForm, JSON.stringify(bad))
  }
  assert.throws(() => P.strictJson(Uint8Array.of(0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d)), TypeError, 'invalid UTF-8')
  for (const [lit, out] of [['1.5', '1.5'], ['1e21', '1e+21'], ['1e-7', '1e-7'], ['100.0', '100'], ['-2.5e-5', '-0.000025'], ['5e-324', '5e-324']]) {
    assert.equal(P.canonicalJson(new P.JFloat(Number(lit))), out, lit)   // the serializer alone, as test_number_forms
  }
  // Through the parser, 1e21 has no canonical form (an integer value beyond 2^53-1), as passport.py's _pfloat says.
  assert.throws(() => P.strictJson(enc('1e21')), (e) => e instanceof P.NoCanonicalForm)
  assert.equal(P.canonicalJson(P.strictJson(enc('{"b":1,"a":[true,null,"\\u00e9"],"\u00e9":{}}'))), '{"a":[true,null,"é"],"b":1,"é":{}}')
})

test('tapeapi-extra: argument errors throw INVALID_ARGUMENT before any read; nothing else throws', async () => {
  const rd = { pinnedBlock: 1, heads: [1], get: async () => { throw new Error('no read expected') } }
  for (const bad of [null, {}, { agentId: -1 }, { agentId: '01' }, { agentId: 1.5 }, { circuit: { processor: 'x', tokenId: 1 } }, { circuit: { processor: '0x' + '11'.repeat(20), tokenId: 0 } }, { name: 'nope' }, { name: '1.2.344.tape' }]) {
    await assert.rejects(P.resolve(rd, bad), (e) => e.code === 'INVALID_ARGUMENT', JSON.stringify(bad))
  }
})

test('browser-safe: src/ imports no node: module and uses no Buffer or process', () => {
  const dir = new URL('../src/', import.meta.url)
  const files = readdirSync(dir).filter((f) => f.endsWith('.js'))
  assert.ok(files.length >= 6)
  for (const f of files) {
    const text = readFileSync(new URL(f, dir), 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
    assert.doesNotMatch(text, /from\s+'node:|import\(\s*'node:|require\(/, f)
    assert.doesNotMatch(text, /\bBuffer\b|\bprocess\./, f)
    for (const m of text.matchAll(/from\s+'([^'.][^']*)'/g)) assert.ok(/^@noble\/hashes\/|^@tapeapi\/sdk(\/|$)/.test(m[1]), `${f} imports ${m[1]}`)
  }
})
