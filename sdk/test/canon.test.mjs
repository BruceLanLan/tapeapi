import { test } from 'node:test'
import assert from 'node:assert/strict'
import { canonicalJSON, safeParseJSON } from '../src/canon.js'
import { TapeAPIError } from '../src/errors.js'

test('canonicalJSON sorts keys recursively without whitespace', () => {
  assert.equal(canonicalJSON({ b: 1, a: { z: [3, { y: 1, x: 2 }], k: 'v' } }), '{"a":{"k":"v","z":[3,{"x":2,"y":1}]},"b":1}')
})
test('canonicalJSON keeps array order and primitives', () => {
  assert.equal(canonicalJSON([true, null, 'x', 1.5]), '[true,null,"x",1.5]')
  assert.equal(canonicalJSON('a"b'), '"a\\"b"')
})
test('canonicalJSON rejects undefined / NaN / Infinity / bigint', () => {
  for (const bad of [{ a: undefined }, { a: NaN }, [Infinity], { a: 1n }, [undefined], undefined]) {
    assert.throws(() => canonicalJSON(bad), (e) => e instanceof TapeAPIError && e.code === 'CANON_INVALID')
  }
})
test('canonicalJSON is stable regardless of insertion order', () => {
  assert.equal(canonicalJSON({ x: 1, y: 2 }), canonicalJSON({ y: 2, x: 1 }))
})
test('M-08: canonicalJSON rejects own __proto__ / constructor / prototype keys instead of dropping them', () => {
  const polluted = JSON.parse('{"a":1,"__proto__":{"polluted":true}}') // JSON.parse makes __proto__ an OWN property
  assert.ok(Object.prototype.hasOwnProperty.call(polluted, '__proto__'))
  assert.throws(() => canonicalJSON(polluted), (e) => e instanceof TapeAPIError && e.code === 'CANON_INVALID' && /__proto__/.test(e.message))
  for (const text of ['{"constructor":{"x":1}}', '{"prototype":1}', '{"nested":[{"__proto__":{}}]}']) {
    assert.throws(() => canonicalJSON(JSON.parse(text)), (e) => e.code === 'CANON_INVALID', text)
  }
  assert.equal(({}).polluted, undefined)
})
test('safeParseJSON parses normal JSON and rejects forbidden keys anywhere / malformed text', () => {
  assert.deepEqual(safeParseJSON('{"b":[1,{"c":null}],"a":"x"}'), { b: [1, { c: null }], a: 'x' })
  for (const text of ['{"__proto__":{"polluted":true}}', '{"a":{"constructor":1}}', '[{"prototype":1}]']) {
    assert.throws(() => safeParseJSON(text), (e) => e instanceof TapeAPIError && e.code === 'CANON_INVALID' && /forbidden key/.test(e.message), text)
  }
  assert.throws(() => safeParseJSON('{not json'), (e) => e.code === 'CANON_INVALID' && /invalid JSON/.test(e.message))
  assert.throws(() => safeParseJSON('{"__proto__":1}', { code: 'BAD_REQUEST' }), (e) => e.code === 'BAD_REQUEST')
  assert.equal(({}).polluted, undefined)
})

// 2026-09-21：签名前的规范化收紧，理由见 sdk/src/canon.js 的注释与进程签名的调研。
// Hardening of the pre-signature canonical form; rationale in canon.js and the process-signing research.
test('canonicalJSON refuses -0, integers past 2^53, and any value carrying toJSON()', () => {
  // -0 serialises as 0, so the two are indistinguishable after the fact / -0 会被序列化成 0，事后无法区分
  assert.throws(() => canonicalJSON([-0]), (e) => e.code === 'CANON_INVALID' && /negative zero/.test(e.message))
  assert.throws(() => canonicalJSON({ n: -0 }), (e) => e.code === 'CANON_INVALID')
  assert.equal(canonicalJSON([0]), '[0]', 'positive zero is fine')

  // 9007199254740993 is already 9007199254740992 by the time JS holds it / 到了 JS 手里它已经变成另一个数
  assert.throws(() => canonicalJSON({ v: 9007199254740993 }), (e) => e.code === 'CANON_INVALID' && /exactly representable/.test(e.message))
  assert.equal(canonicalJSON({ v: 9007199254740991 }), '{"v":9007199254740991}', 'the boundary itself is fine')
  assert.equal(canonicalJSON({ v: '9007199254740993' }), '{"v":"9007199254740993"}', 'as a string it is exact')
  // 1e21 is an integer too, so the same rule catches it: past 2^53 the string form is the only unambiguous one.
  // 1e21 同样是整数，因此被同一条规则拦下：超过 2^53 之后，字符串是唯一没有歧义的形式。
  assert.throws(() => canonicalJSON({ v: 1e21 }), (e) => e.code === 'CANON_INVALID' && /exactly representable/.test(e.message))
  assert.equal(canonicalJSON({ v: 0.1 }), '{"v":0.1}', 'fractional values are unaffected')
  assert.equal(canonicalJSON({ v: 1.5e-7 }), '{"v":1.5e-7}')

  // toJSON is a JavaScript-only hook; no Go or Python verifier reproduces it / 只有 JS 有这个钩子
  assert.throws(() => canonicalJSON({ at: new Date(0) }), (e) => e.code === 'CANON_INVALID' && /toJSON/.test(e.message))
  assert.throws(() => canonicalJSON({ x: { toJSON: () => 1 } }), (e) => e.code === 'CANON_INVALID' && /toJSON/.test(e.message))
})

test('safeParseJSON rejects duplicate keys instead of silently keeping the last one', () => {
  assert.deepEqual(safeParseJSON('{"a":1,"b":2}'), { a: 1, b: 2 })
  for (const bad of [
    '{"a":1,"a":2}',
    '{"a":1,"b":{"c":1,"c":2}}',
    '{"outer":[{"k":1,"k":2}]}',
    '{"a\\"b":1,"a\\"b":2}',            // the repeated key contains an escaped quote / 重复的键里带转义引号
    '{"\\u0061":1,"a":2}',                 // and one is written as an escape / 其中一个写成转义形式
  ]) {
    assert.throws(() => safeParseJSON(bad), (e) => e.code === 'CANON_INVALID' && /duplicate key/.test(e.message), bad)
  }
  // the same name in DIFFERENT objects, or as a string value, is not a duplicate / 不同对象里的同名键、或作为字符串值，都不算重复
  assert.deepEqual(safeParseJSON('{"x":{"a":1},"y":{"a":2}}'), { x: { a: 1 }, y: { a: 2 } })
  assert.deepEqual(safeParseJSON('{"a":"a","b":"a"}'), { a: 'a', b: 'a' })
  assert.deepEqual(safeParseJSON('[{"a":1},{"a":2}]'), [{ a: 1 }, { a: 2 }])
  assert.deepEqual(safeParseJSON('{"list":["a","a"]}'), { list: ['a', 'a'] })
})
