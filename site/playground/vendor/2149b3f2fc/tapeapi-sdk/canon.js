import { TapeAPIError } from './errors.js'

// 这些键永远不能出现在可签名 / 可解析的 JSON 里：JSON.parse 会把它们建成自有属性，而普通赋值会走原型链（M-08）。
// These keys are never allowed in signable or parsed JSON: JSON.parse creates them as own properties while a plain
// assignment walks the prototype chain, so they silently vanish from the canonical form (review M-08).
export const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

// Find a repeated key inside any one object. `JSON.parse` keeps the LAST of a duplicate pair and says nothing,
// so `{"a":1,"a":2}` parses to `{a:2}` and its canonical form is one a different implementation may not agree
// on: two parsers can legitimately disagree about which value survived, which is exactly how signature-
// verification bypasses are built (the JWS/JWT family of "same bytes, different meaning" bugs). RFC 8785 §3
// forbids duplicates outright, so TAPI rejects them rather than picking a winner.
// 找出同一个对象里重复出现的键。`JSON.parse` 保留重复键的最后一个且不作声，于是 `{"a":1,"a":2}` 解析成 `{a:2}`，
// 它的规范形式未必被另一个实现认同：两个解析器对"谁活下来"可以有不同结论，而这正是签名校验绕过的构造方式
// （JWS/JWT 那一类"同样的字节、不同的含义"）。RFC 8785 §3 直接禁止重复键，因此 TAPI 拒绝，而不是挑一个赢家。
export function findDuplicateKey(text) {
  const n = text.length
  let i = 0
  const stack = []        // a Set per open object, null per open array / 每个打开的对象一个集合，数组则为 null
  let expectKey = false
  const readString = () => {
    let out = ''
    i++                                            // opening quote / 开引号
    while (i < n) {
      const c = text[i]
      if (c === '\\') {
        const e = text[i + 1]
        if (e === 'u') { out += String.fromCharCode(parseInt(text.slice(i + 2, i + 6), 16)); i += 6 }
        else { out += ({ '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' })[e] ?? e; i += 2 }
        continue
      }
      if (c === '"') { i++; return out }
      out += c; i++
    }
    return out
  }
  const inObject = () => stack.length > 0 && stack[stack.length - 1] !== null
  while (i < n) {
    const c = text[i]
    if (c === '"') {
      const key = readString()
      if (expectKey && inObject()) {
        const seen = stack[stack.length - 1]
        if (seen.has(key)) return key
        seen.add(key)
        expectKey = false
      }
      continue
    }
    if (c === '{') { stack.push(new Set()); expectKey = true; i++; continue }
    if (c === '[') { stack.push(null); expectKey = false; i++; continue }
    if (c === '}' || c === ']') { stack.pop(); expectKey = false; i++; continue }
    if (c === ',') { expectKey = inObject(); i++; continue }
    i++
  }
  return null
}

// 解析不可信 JSON：拒绝原型键、重复键 / Parse untrusted JSON, rejecting prototype-polluting and duplicate keys.
// Throws TapeAPIError(code) (default CANON_INVALID) on malformed JSON, a forbidden key, or a repeated key.
export function safeParseJSON(text, { code = 'CANON_INVALID' } = {}) {
  let parsed
  try {
    parsed = JSON.parse(text, (k, v) => {
      if (FORBIDDEN_KEYS.has(k)) throw new TapeAPIError(code, `forbidden key "${k}" in JSON`)
      return v
    })
  } catch (e) {
    if (e instanceof TapeAPIError) throw e
    throw new TapeAPIError(code, `invalid JSON: ${e.message}`)
  }
  if (typeof text === 'string') {
    const dup = findDuplicateKey(text)
    if (dup !== null) throw new TapeAPIError(code, `duplicate key "${dup}" in JSON: RFC 8785 forbids it and two parsers may disagree about which value survives`)
  }
  return parsed
}

// 递归键排序、无空白的 JSON / Deterministic JSON: sorted keys, no whitespace.
//
// The string is produced in one pass instead of building a plain object and handing it to `JSON.stringify`,
// because a JavaScript object cannot carry the order we need: integer-index keys live in a separate list, kept
// in numeric order, ahead of every other key. Insert "10" then "2" and the object hands them back "2","10", so
// `{"1":_,"10":_,"2":_}` silently became `{"1":_,"2":_,"10":_}` however carefully the keys had been sorted.
// Every other language sorts those keys as the strings they are, so a signer and a verifier written in
// different languages computed different digests for any object with numeric-looking keys: a token id, a chain
// id, an index, a year, a block number. Found 2026-09-21 by spec/vectors/verify.py, an independent Python
// implementation, on its first run. Three audits and 249 tests had missed it, because both sides of every one
// of those tests were this same function.
// 一次成串，而不是先建普通对象再交给 `JSON.stringify`：JavaScript 对象承载不了我们需要的顺序，整数索引键被
// 放在一个按数值排序、且排在所有其它键之前的独立列表里。先插 "10" 再插 "2"，对象还给你的是 "2","10"，
// 于是 `{"1":_,"10":_,"2":_}` 会悄悄变成 `{"1":_,"2":_,"10":_}`，无论事先排得多仔细。其它语言都把这些键
// 当字符串排序，因此不同语言写的签名方与验证方，对任何带数字样式键的对象（tokenId、chainId、下标、年份、
// 区块号）会算出不同的摘要。2026-09-21 由独立的 Python 实现 spec/vectors/verify.py 在首次运行时发现；
// 三轮审计和 249 个测试都没抓到，因为那些测试的两边都是这同一个函数。
export function canonicalJSON(value) {
  return canonicalize(value, '')
}

// 规范化并拒绝不可表示的值，直接产出规范字符串 / Normalise, reject what JSON cannot represent, emit the string.
// `JSON.stringify` is still used for every LEAF: its string escaping and shortest round-trip number form are
// exactly what JCS (RFC 8785) specifies. Only the ordering of object members is ours to control.
// 叶子节点仍交给 `JSON.stringify`：它的字符串转义与最短往返数字形式正是 JCS 所规定的。只有对象成员的顺序由我们控制。
// A lone UTF-16 surrogate is not a Unicode character. JCS builds on I-JSON (RFC 7493 §2.1), which forbids them,
// and implementations genuinely disagree on how to write one: JavaScript escapes it as \ud800, Python cannot even
// encode it as UTF-8. A fuzzer found 27,911 such disagreements on 2026-09-22; refusing is the only safe answer.
// 单独出现的 UTF-16 代理项不是 Unicode 字符。JCS 基于 I-JSON（RFC 7493 §2.1），后者禁止它们；而各实现对它的写法
// 确实各不相同：JavaScript 转义成 \ud800，Python 连 UTF-8 都编码不了。拒绝是唯一安全的做法。
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
function checkString(v, path) {
  if (LONE_SURROGATE.test(v)) throw new TapeAPIError('CANON_INVALID', `lone UTF-16 surrogate at ${path || '$'}: not well-formed Unicode (RFC 7493 §2.1)`)
  return v
}

function canonicalize(v, path) {
  if (v === null) return 'null'
  const t = typeof v
  if (t === 'boolean') return v ? 'true' : 'false'
  if (t === 'string') return JSON.stringify(checkString(v, path))
  if (t === 'number') {
    if (!Number.isFinite(v)) throw new TapeAPIError('CANON_INVALID', `non-finite number at ${path || '$'}`)
    // An integer past 2^53 has already lost precision by the time it is a JS number, so signer and verifier can
    // disagree about a value neither of them mis-typed. TAPI-20 already carries amounts and token ids as strings;
    // this makes that the general rule. RFC 7493 §2.2 gives the same advice.
    // 超过 2^53 的整数在成为 JS number 时就已丢失精度，签名方与验证方会对一个谁都没打错的值产生分歧。
    // TAPI-20 本来就用字符串携带金额与 tokenId，这里把它变成通则。RFC 7493 §2.2 是同样的建议。
    if (Number.isInteger(v) && !Number.isSafeInteger(v)) {
      throw new TapeAPIError('CANON_INVALID', `integer ${v} at ${path || '$'} is outside the exactly representable range; carry it as a string`)
    }
    if (Object.is(v, -0)) throw new TapeAPIError('CANON_INVALID', `negative zero at ${path || '$'}: it serialises as 0 and the two forms are not distinguishable`)
    return JSON.stringify(v)
  }
  if (t === 'undefined' || t === 'function' || t === 'symbol' || t === 'bigint') {
    throw new TapeAPIError('CANON_INVALID', `unsupported ${t} at ${path || '$'}`)
  }
  // By index, not map(): map skips the holes of a sparse array and join would write '[1,,2]', which is not JSON. A hole
  // reads as undefined and is refused like one. / 按下标而不是 map()：map 跳过稀疏数组的空位，join 会写出不是 JSON 的
  // '[1,,2]'。空位读作 undefined，按 undefined 拒绝。
  if (Array.isArray(v)) {
    const items = []
    for (let i = 0; i < v.length; i++) items.push(canonicalize(v[i], `${path}[${i}]`))
    return '[' + items.join(',') + ']'
  }
  // `toJSON` exists only in JavaScript. A Date, a BigNumber or a class carrying one canonicalises here to
  // something a Go or Python verifier computing over the same logical value would never produce, and the
  // mismatch surfaces as a signature failure nobody can explain. Refuse; let the caller convert explicitly.
  // `toJSON` 只存在于 JavaScript。带它的 Date、BigNumber 或某个类在这里会被规范化成 Go 或 Python 验证方
  // 对同一逻辑值绝不会算出的形状，而这种分歧表现为谁也解释不清的验签失败。直接拒绝，让调用方显式转换。
  if (typeof v.toJSON === 'function') {
    throw new TapeAPIError('CANON_INVALID', `value at ${path || '$'} has a toJSON() method; convert it to a plain JSON value before signing (toJSON is a JavaScript-only hook and no other language will reproduce it)`)
  }
  // Default `.sort()` compares UTF-16 code units, which is what JCS (RFC 8785 §3.2.3) requires. Emitting the
  // members right here is what preserves that order: nothing downstream gets a chance to re-order them.
  // 默认的 `.sort()` 按 UTF-16 码元比较，正是 JCS 所要求的。就地输出成员才能保住这个顺序。
  const parts = []
  for (const k of Object.keys(v).sort()) {
    if (FORBIDDEN_KEYS.has(k)) throw new TapeAPIError('CANON_INVALID', `forbidden key "${k}" at ${path || '$'}`)
    const item = v[k]
    if (item === undefined) throw new TapeAPIError('CANON_INVALID', `undefined at ${path}.${k}`)
    parts.push(JSON.stringify(checkString(k, `${path}.<key>`)) + ':' + canonicalize(item, `${path}.${k}`))
  }
  return '{' + parts.join(',') + '}'
}
