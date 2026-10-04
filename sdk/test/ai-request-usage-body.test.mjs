// requestUsageBody (1.6): the usage member set in the request's bytes, one splice, checked against the sidecar's own
// change (prepareUpstream). A corpus of the shapes that matter, the gates, and a property test over random JSON texts
// written with random whitespace, escapes, duplicates and numbers JSON.stringify cannot reproduce.
// requestUsageBody：在请求字节里设置用量成员，一次拼接，并对照旁路自己的改动自检。语料、门槛，以及对随机 JSON 文本的性质测试。
import test from 'node:test'
import assert from 'node:assert/strict'
import { gzipSync } from 'node:zlib'
import * as ai from '../src/ai.js'

const chat = ai.FORMATS.find((f) => f.name === 'openai-chat')
const te = new TextEncoder(), td = new TextDecoder()
const ask = (body, headers) => ai.requestUsageBody(typeof body === 'string' ? te.encode(body) : body, { format: chat, headers })
const text = (r) => { assert.ok(r && r.bytes, `rewritten: ${JSON.stringify(r)}`); return td.decode(r.bytes) }
const SO = '"stream_options":{"include_usage":true}'

// [name, body, expected bytes] — every other byte stays. / 其余字节一律不变。
const REWRITTEN = [
  ['no stream_options: appended after the last member', '{"model":"m","stream":true}', `{"model":"m","stream":true,${SO}}`],
  ['an integer beyond 2^53 is sent as written', '{"seed":12345678901234567890,"stream":true}', `{"seed":12345678901234567890,"stream":true,${SO}}`],
  ['1e400 is sent as written (JSON.stringify would send null)', '{"temperature":1e400,"stream":true}', `{"temperature":1e400,"stream":true,${SO}}`],
  ['1.0, -0, 1E2 and 0.1e-7 as written', '{"a":1.0,"b":-0,"c":1E2,"d":0.1e-7,"stream":true}', `{"a":1.0,"b":-0,"c":1E2,"d":0.1e-7,"stream":true,${SO}}`],
  ['a nested duplicate key is kept', '{"messages":[{"role":"user","content":"a","content":"b"}],"stream":true}', `{"messages":[{"role":"user","content":"a","content":"b"}],"stream":true,${SO}}`],
  ['unicode escapes, \\/ and raw UTF-8 as written', '{"m":"caf\\u00e9 \\ud83d\\ude00 a\\/b ü 😀","stream":true}', `{"m":"caf\\u00e9 \\ud83d\\ude00 a\\/b ü 😀","stream":true,${SO}}`],
  ['indentation kept, the member after the last value', '{\n  "model": "m",\n  "stream": true\n}\n', `{\n  "model": "m",\n  "stream": true,${SO}\n}\n`],
  ['trailing whitespace (a salt) kept', '{"stream":true} \t\r\n ', `{"stream":true,${SO}} \t\r\n `],
  ['leading whitespace kept', ' \n{"stream":true}', ` \n{"stream":true,${SO}}`],
  ['stream_options {}: include_usage put in it', '{"stream":true,"stream_options":{},"x":1}', '{"stream":true,"stream_options":{"include_usage":true},"x":1}'],
  ['stream_options { } with whitespace', '{"stream":true,"stream_options":{ \n }}', '{"stream":true,"stream_options":{"include_usage":true \n }}'],
  ['stream_options with another member: appended in it', '{"stream_options":{"continuous_usage_stats":false},"stream":true}', '{"stream_options":{"continuous_usage_stats":false,"include_usage":true},"stream":true}'],
  ['include_usage false: its value replaced, its place kept', '{"stream":true,"stream_options":{"include_usage":false,"b":2}}', '{"stream":true,"stream_options":{"include_usage":true,"b":2}}'],
  ['include_usage "true": replaced', '{"stream":true,"stream_options":{"include_usage":"true"}}', '{"stream":true,"stream_options":{"include_usage":true}}'],
  ['include_usage null: replaced', '{"stream":true,"stream_options":{"a":[],"include_usage":null}}', '{"stream":true,"stream_options":{"a":[],"include_usage":true}}'],
  ['include_usage 1: replaced', '{"stream":true,"stream_options":{"include_usage":1}}', '{"stream":true,"stream_options":{"include_usage":true}}'],
  ['include_usage written with spaces around', '{"stream":true,"stream_options":{ "include_usage" : 0 }}', '{"stream":true,"stream_options":{ "include_usage" : true }}'],
  ['stream_options null: replaced by an object', '{"stream":true,"stream_options":null,"z":0}', '{"stream":true,"stream_options":{"include_usage":true},"z":0}'],
  ['stream_options an array: replaced', '{"stream":true,"stream_options":[1,{"x":"}"}],"z":0}', '{"stream":true,"stream_options":{"include_usage":true},"z":0}'],
  ['stream_options a string: replaced', '{"stream":true,"stream_options":"{\\"include_usage\\":true}"}', '{"stream":true,"stream_options":{"include_usage":true}}'],
  ['stream_options false, last member: replaced', '{"stream":true,"stream_options":false}', '{"stream":true,"stream_options":{"include_usage":true}}'],
  ['an escaped key that means stream_options is found', '{"stream\\u005foptions":{"a":1},"stream":true}', '{"stream\\u005foptions":{"a":1,"include_usage":true},"stream":true}'],
  ['"stream_options" inside a string is not a member', '{"messages":[{"content":"\\"stream_options\\":{}"}],"stream":true}', `{"messages":[{"content":"\\"stream_options\\":{}"}],"stream":true,${SO}}`],
  ['a key with escaped quotes and backslashes before it', '{"a\\"\\\\":"}\\\\","stream":true}', `{"a\\"\\\\":"}\\\\","stream":true,${SO}}`],
  ['__proto__ as a key', '{"__proto__":{"x":1},"stream":true}', `{"__proto__":{"x":1},"stream":true,${SO}}`],
  // F1 regression: names that only look like the members, and a case variant deeper down, are not refused.
  // F1 回归：只是相像的名字、更深处的大小写变体，都不拒绝。
  ['near names and a deeper case variant are left alone', '{"stream":true,"stream_options_x":1,"STREAM":1,"stream_options":{"include_usage2":false,"a":{"INCLUDE_USAGE":1}}}', '{"stream":true,"stream_options_x":1,"STREAM":1,"stream_options":{"include_usage2":false,"a":{"INCLUDE_USAGE":1},"include_usage":true}}'],
  ['integer-like keys (ordered first by JavaScript)', '{"stream":true,"1":"x"}', `{"stream":true,"1":"x",${SO}}`],
]
for (const [name, body, want] of REWRITTEN) {
  test(`requestUsageBody rewrites in one place: ${name}`, () => {
    const r = ask(body)
    assert.equal(text(r), want)
    // The check the function makes, made again here: what the sidecar would send, and nothing more to change.
    // 函数自己的检查，在此再做一遍：就是旁路会发出的内容，且不再有可改之处。
    assert.equal(JSON.stringify(JSON.parse(want)), JSON.stringify(chat.prepareUpstream(JSON.parse(body)).body))
    assert.equal(chat.prepareUpstream(JSON.parse(want)), null)
    assert.equal(ask(want), null, 'idempotent: the new bytes need nothing')
  })
}

test('requestUsageBody: not applicable (null, nothing reported) where the sidecar changes nothing', () => {
  for (const body of ['{"stream":false}', '{"model":"m"}', '{"stream":"true"}', '{"stream":1}', `{"stream":true,${SO}}`, '{"stream":true,"stream_options":{"include_usage":true,"x":1}}',
    '[{"stream":true}]', '"stream"', '1', 'null', '', '{"stream":true', 'not json', '{"stream":true,"stream":false}']) assert.equal(ask(body), null, JSON.stringify(body))
  assert.equal(ask(new Uint8Array(0)), null)
  // Formats that never inject. / 从不注入的格式。
  for (const f of ai.FORMATS.filter((x) => x !== chat)) assert.equal(ai.requestUsageBody(te.encode('{"stream":true}'), { format: f }), null, f.name)
})

test('requestUsageBody: the gates, in order, each a refusal with its reason (bytes untouched)', () => {
  const body = te.encode('{"model":"m","stream":true}')
  const cases = [
    ['content-encoding', body, { 'content-encoding': 'gzip' }],
    ['content-encoding', body, { 'content-encoding': 'br', 'content-type': 'application/json' }],
    ['content-type', body, { 'content-type': 'text/plain' }],
    ['content-type', body, { 'content-type': 'application/x-www-form-urlencoded' }],
    ['not-utf8', new Uint8Array([...te.encode('{"stream":true,"x":"'), 0xff, ...te.encode('"}')]), {}],
    ['not-utf8', new Uint8Array([...te.encode('{"stream":true,"x":"'), 0xed, 0xa0, 0x80, ...te.encode('"}')]), {}],
    ['not-object', te.encode('﻿{"stream":true}'), {}],
    ['duplicate-member', te.encode('{"stream":true,"stream":true}'), {}],
    ['duplicate-member', te.encode('{"stream":false,"stream":true}'), {}],
    ['duplicate-member', te.encode('{"model":"a","model":"b","stream":true}'), {}],
    ['duplicate-member', te.encode('{"stream":true,"stream_options":{},"stream_options":{"a":1}}'), {}],
    ['duplicate-member', te.encode('{"stream":true,"stream_options":{"include_usage":true},"stream_options":{}}'), {}],
    ['duplicate-member', te.encode('{"stream":true,"stream_options":{"include_usage":false,"include_usage":false}}'), {}],
    ['duplicate-member', te.encode('{"stream":true,"stream\\u005foptions":{},"stream_options":{}}'), {}],
    // FIXED AI-ASK-CASE (Fable review F1): the member's name in another case, read as the member by case-insensitive,
    // last-wins parsers (Go's encoding/json in new-api / one-api). / 成员名的大小写变体。
    ['duplicate-member', te.encode('{"stream":true,"stream_options":{"include_usage":false,"INCLUDE_USAGE":false}}'), {}],
    ['duplicate-member', te.encode('{"stream":true,"stream_options":{"Include_Usage":false}}'), {}],
    ['duplicate-member', te.encode('{"stream":true,"stream_options":{"INCLUDE\\u005fUSAGE":0,"a":1}}'), {}],
    ['duplicate-member', te.encode('{"stream":true,"stream_options":{"include_u\\u017fage":false}}'), {}],
    ['duplicate-member', te.encode('{"stream":true,"STREAM_OPTIONS":{"include_usage":false}}'), {}],
    ['duplicate-member', te.encode('{"Stream_Options":null,"stream":true,"stream_options":{}}'), {}],
    ['duplicate-member', te.encode('{"stream":true,"stream_options":{},"\\u0053tream_options":{}}'), {}],
  ]
  for (const [reason, b, h] of cases) {
    const before = b.slice()
    assert.deepEqual(ai.requestUsageBody(b, { format: chat, headers: h }), { skipped: reason }, `${reason}: ${td.decode(b)} ${JSON.stringify(h)}`)
    assert.deepEqual(b, before, 'not touched')
  }
  // A custom adapter that changes the request but names no member. / 自定义适配器改动请求却没有给出成员。
  const custom = { ...chat, usageMember: undefined }
  assert.deepEqual(ai.requestUsageBody(body, { format: custom }), { skipped: 'no-member' })
  for (const m of [['stream_options'], ['a', 'b', 'c'], [1, 2], 'stream_options.include_usage']) assert.deepEqual(ai.requestUsageBody(body, { format: { ...chat, usageMember: m } }), { skipped: 'no-member' }, JSON.stringify(m))
  // A custom adapter whose member is not what its prepareUpstream sets: the self-check refuses it.
  // 成员与 prepareUpstream 实际设置的不一致的自定义适配器：自检拒绝。
  assert.deepEqual(ai.requestUsageBody(body, { format: { ...chat, usageMember: ['stream_options', 'include_usage_x'] } }), { skipped: 'self-check' })
  assert.deepEqual(ai.requestUsageBody(body, { format: { ...chat, prepareUpstream: (j) => (j?.stream === true ? { body: { ...j, stream_options: { include_usage: true }, extra: 1 }, strip: true } : null) } }), { skipped: 'self-check' })
  // Compressed bytes never parse, so the sidecar does not inject either: not applicable. / 压缩字节无法解析：旁路也不注入。
  assert.equal(ai.requestUsageBody(new Uint8Array(gzipSync(body)), { format: chat, headers: { 'content-encoding': 'gzip' } }), null)
  // JSON types: +json, a charset, no content type, identity coding. / JSON 类型。
  for (const h of [{ 'content-type': 'application/json; charset=utf-8' }, { 'content-type': 'application/vnd.api+json' }, {}, { 'content-encoding': 'identity' }, new Headers({ 'content-type': 'application/json' })]) assert.ok(ai.requestUsageBody(body, { format: chat, headers: h })?.bytes, JSON.stringify(h))
  // Every reason is listed and has its words. / 每个原因都在列表里且有说明。
  assert.deepEqual([...ai.USAGE_REQUEST_SKIPS], ['content-encoding', 'content-type', 'not-utf8', 'not-object', 'no-member', 'duplicate-member', 'self-check'])
  for (const r of ai.USAGE_REQUEST_SKIPS) assert.notEqual(ai.usageRequestSkipWhy(r), r)
})

test('requestUsageBody: forms of the bytes (string, ArrayBuffer, a view) and a long or deep body', () => {
  const s = '{"stream":true}'
  for (const b of [s, te.encode(s).buffer, new DataView(te.encode(s).buffer), te.encode(s)]) assert.equal(td.decode(ai.requestUsageBody(b, { format: chat }).bytes), `{"stream":true,${SO}}`)
  const big = `{"messages":[{"role":"user","content":"${'x'.repeat(8 * 1024 * 1024)}"}],"stream":true}`
  assert.equal(text(ask(big)), big.slice(0, -1) + `,${SO}}`)
  const deep = `{"x":${'['.repeat(3000)}${']'.repeat(3000)},"stream":true}`
  assert.equal(text(ask(deep)), deep.slice(0, -1) + `,${SO}}`)
  // Deeper than JSON.stringify can go (the self-check compares two serialisations): refused, never a crash. The sidecar
  // re-serialises such a body itself today, and fails the same way. / 比 JSON.stringify 能处理的更深：拒绝，绝不崩溃。
  assert.deepEqual(ask(`{"x":${'['.repeat(20000)}${']'.repeat(20000)},"stream":true}`), { skipped: 'self-check' })
  const many = `{${Array.from({ length: 20000 }, (_, i) => `"k${i}":${i}`).join(',')},"stream":true}`
  assert.equal(text(ask(many)), many.slice(0, -1) + `,${SO}}`)
})

// ---- property test / 性质测试 ----
// Random JSON texts, written token by token (not by JSON.stringify): random whitespace, escapes in keys and strings,
// numbers in every JSON spelling, nesting, and keys drawn from a small pool so duplicates and the members the rule reads
// come up often. / 随机 JSON 文本，逐个记号写出：随机空白、键与字符串里的转义、各种写法的数字、嵌套，键取自小池子以常出现重复与规则读取的成员。
function rng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32 } }
function generator(r) {
  const pick = (a) => a[Math.floor(r() * a.length)]
  const ws = () => (r() < 0.6 ? '' : pick([' ', '\n', '\t', '\r\n', '  ', ' \n  ']))
  const esc = (s) => s.replace(/[a-z_]/g, (c) => (r() < 0.15 ? `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}` : c))
  const str = () => `"${pick(['', 'hi', 'caf\\u00e9', '\\"q\\"', 'a\\\\b', '}{][,:', '😀', '\\ud83d\\ude00', 'stream_options', '\\/', 'ü'])}"`
  const num = () => pick(['0', '-0', '1', '12345678901234567890', '1e400', '-1E-400', '1.0', '0.5e2', '3.14159', '-7'])
  // Case variants of the two member names (Fable review F1) come up too, some with a letter Go folds onto ASCII (U+017F).
  // 两个成员名的大小写变体也会出现（F1），有的含 Go 折叠到 ASCII 的字母（U+017F）。
  const KEYS = ['stream', 'stream_options', 'include_usage', 'model', 'messages', '__proto__', 'a', 'b', '1', 'seed', 'STREAM_OPTIONS', 'Include_Usage', 'include_u\u017fage', 'stream_options_x']
  const key = () => `"${esc(pick(KEYS))}"`
  function value(d) {
    const k = r()
    if (d > 3 || k < 0.3) return pick([str, num, () => pick(['true', 'false', 'null'])])()
    if (k < 0.6) { const n = Math.floor(r() * 4); return `[${ws()}${Array.from({ length: n }, () => value(d + 1)).join(`${ws()},${ws()}`)}${ws()}]` }
    return object(d + 1)
  }
  function object(d, extra = []) {
    const n = Math.floor(r() * 4)
    const members = Array.from({ length: n }, () => `${key()}${ws()}:${ws()}${value(d)}`)
    for (const e of extra) members.splice(Math.floor(r() * (members.length + 1)), 0, e)
    return `{${ws()}${members.join(`${ws()},${ws()}`)}${ws()}}`
  }
  return () => {
    const extra = [`"${esc('stream')}"${ws()}:${ws()}${r() < 0.85 ? 'true' : pick(['false', '"true"', 'null'])}`]
    const so = r()
    if (so < 0.3) extra.push(`"${esc('stream_options')}":${ws()}${object(1, r() < 0.5 ? [`"${esc('include_usage')}":${pick(['true', 'false', 'null', '0', '"x"'])}`] : [])}`)
    else if (so < 0.45) extra.push(`"${esc('stream_options')}":${pick(['null', 'false', '[]', '"s"', '1'])}`)
    return ws() + object(0, extra) + ws()
  }
}
// Duplicates at the top level or in the top-level stream_options object, counted by an independent walk over the text.
// 用独立的文本遍历数出顶层或顶层 stream_options 对象里的重复键。
function topDuplicates(src) {
  const frames = []
  let top = null, so = null
  for (let i = 0; i < src.length; i++) {
    const c = src[i], f = frames[frames.length - 1]
    if (c === '"') {
      let j = i + 1; while (src[j] !== '"') j += src[j] === '\\' ? 2 : 1
      if (f && f.kind === '{' && f.expectKey) { const k = JSON.parse(src.slice(i, j + 1)); f.keys.push(k); f.key = k; f.expectKey = false }
      i = j; continue
    }
    if (c === '{' || c === '[') {
      const fr = { kind: c, keys: [], key: null, expectKey: c === '{' }
      if (!frames.length) top = fr
      else if (frames.length === 1 && c === '{' && f.key === 'stream_options') so = fr
      frames.push(fr)
    } else if (c === '}' || c === ']') frames.pop()
    else if (c === ',' && f.kind === '{') f.expectKey = true
  }
  const twice = (a) => new Set(a).size !== a.length
  // F1: a key that is the member's name in another case counts as a duplicate too. / F1：大小写变体也算重复。
  const fold = (k) => k.toUpperCase().toLowerCase()
  const twin = (keys, name) => keys.some((k) => k !== name && fold(k) === fold(name))
  return twice(top.keys) || twin(top.keys, 'stream_options') || (so ? twice(so.keys) || twin(so.keys, 'include_usage') : false)
}
// Find how `out` came from `inp`: one fixed text inserted, or one whole JSON value replaced by it. / 找出 out 怎样由 inp 得来。
function oneSplice(inp, out) {
  for (const t of [`,${SO}`, SO, ',"include_usage":true', '"include_usage":true', '{"include_usage":true}', 'true']) {
    for (let k = out.indexOf(t); k >= 0; k = out.indexOf(t, k + 1)) {
      const b = inp.length - (out.length - k - t.length)
      if (b < k || out.slice(0, k) !== inp.slice(0, k) || out.slice(k + t.length) !== inp.slice(b)) continue
      const removed = inp.slice(k, b)
      if (removed === '') return true
      try { JSON.parse(removed); if (!/^\s|\s$/.test(removed)) return true } catch { /* not one value */ }
    }
  }
  return false
}
test('requestUsageBody, property: over 3000 random JSON texts, applicable exactly when the sidecar would inject; then one splice that parses to prepareUpstream\'s body, or duplicate-member', () => {
  const r = rng(20261004)
  const gen = generator(r)
  const counts = { rewritten: 0, duplicate: 0, notApplicable: 0 }
  for (let n = 0; n < 3000; n++) {
    const t = gen()
    let parsed
    try { parsed = JSON.parse(t) } catch (e) { assert.fail(`the generator wrote invalid JSON: ${t} (${e.message})`) }
    const prepared = chat.prepareUpstream(parsed)
    const got = ask(t)
    if (!prepared) { assert.equal(got, null, t); counts.notApplicable++; continue }
    if (topDuplicates(t)) { assert.deepEqual(got, { skipped: 'duplicate-member' }, t); counts.duplicate++; continue }
    const out = text(got)
    assert.equal(JSON.stringify(JSON.parse(out)), JSON.stringify(prepared.body), t)
    assert.equal(chat.prepareUpstream(JSON.parse(out)), null, t)
    assert.ok(oneSplice(t, out), `not one splice:\n${t}\n${out}`)
    counts.rewritten++
  }
  // The corpus exercises every branch. / 语料覆盖每个分支。
  assert.ok(counts.rewritten > 800 && counts.duplicate > 100 && counts.notApplicable > 100, JSON.stringify(counts))
})
