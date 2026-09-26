// Minimised counterexamples from the differential fuzz of canonicalJSON vs spec/vectors/verify.py (docs/AUDIT-runtime-2.md
// §fuzz). verify.py runs its full checker on import, so its canonicalJSON block is sliced out by source markers and
// exec'd -- the file itself is not modified. The full fuzz harness lives outside the repo (see the report).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { canonicalJSON, safeParseJSON, findDuplicateKey } from '../src/canon.js'

const VERIFY = fileURLToPath(new URL('../../spec/vectors/verify.py', import.meta.url))
const PY = `
import json, sys, pathlib
src = pathlib.Path(sys.argv[1]).read_text()
ns = {}
exec(src[src.index('# ------------------------------------------------------- canonicalJSON'):src.index('# ------------------------------------------------------------------ digests')], ns)
out = []
for t in json.loads(sys.stdin.read()):
    try: out.append({'ok': ns['canonical'](json.loads(t))})
    except Exception as e: out.append({'err': type(e).__name__})
print(json.dumps(out, ensure_ascii=True))
`
const py = (texts) => JSON.parse(execFileSync('python3', ['-c', PY, VERIFY], { input: JSON.stringify(texts) }).toString())
const js = (t) => { try { return { ok: canonicalJSON(safeParseJSON(t)) } } catch (e) { return { err: e.code } } }

test('FIXED FZ-1: verify.py now writes numbers in [1e-6, 1e-4) exactly as ECMAScript does (0.00001)', () => {
  const texts = ['0.00001', '1.5e-7', '0.000123', '-0.00001']
  assert.deepEqual(py(texts).map((r) => r.ok), texts.map((t) => js(t).ok))
  assert.equal(js('0.00001').ok, '0.00001')
})

test('FIXED FZ-2: a lone surrogate has no canonical form in either implementation', () => {
  assert.throws(() => canonicalJSON({ a: '\ud800' }), (e) => e.code === 'CANON_INVALID' && /surrogate/.test(e.message))
  assert.throws(() => canonicalJSON({ ['\udc00']: 1 }), (e) => e.code === 'CANON_INVALID')
  assert.equal(canonicalJSON({ a: '😀' }), '{"a":"😀"}', 'a valid pair is fine')
  assert.deepEqual(py(['"\\ud800"', '{"\\udc00":1}']).map((r) => !!r.err), [true, true], 'verify.py refuses them too')
})

test('FZ-3: JSON text "-0" -- the SDK rejects it as negative zero, verify.py canonicalises it to 0', () => {
  const [z] = py(['{"a":-0}'])
  assert.deepEqual(js('{"a":-0}'), { err: 'CANON_INVALID' })
  assert.deepEqual(z, { ok: '{"a":0}' })
})

test('P-07: findDuplicateKey handles escapes that spell an existing key, pairs split across escapes, and nesting', () => {
  assert.equal(findDuplicateKey('{"a":1,"\\u0061":2}'), 'a')
  assert.equal(findDuplicateKey('{"\\ud83d\\ude00":1,"😀":2}'), '😀')
  assert.equal(findDuplicateKey('{"\\"":1,"\\u0022":2}'), '"')
  assert.equal(findDuplicateKey('{"a":{"a":1},"b":["a","a"],"c":{"x":1}}'), null)
  assert.equal(findDuplicateKey('{"a":[{"k":1,"k":2}]}'), 'k')
  assert.equal(findDuplicateKey('{"a":"{\\"a\\":1,","a":2}'), 'a')
})
