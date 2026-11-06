// Property: mcp.toolsSha256 (TAPI-20 §3.8) is the SHA-256 of the RFC 8785 canonical JSON of the tool list reduced to
// name, title, description, inputSchema, outputSchema and annotations, sorted by name, names unique. So, for random
// tool lists: the digest does NOT change with the order of the list, the order of keys at any depth, the whitespace of
// the JSON text it was parsed from, or members outside those six (icons, _meta, anything else); it DOES change with any
// change inside the six -- one character of a string (whitespace inside a string, letter case, NFC against NFD
// included), a number, a boolean, a nested schema leaf, a key name, an added or removed member, the order of an array
// inside a schema -- and a repeated name is refused. The digest also equals an independent computation: sort by name
// in UTF-16 code-unit order, stringify with sorted keys, node:crypto SHA-256.
// A failure prints its seed; PROP_SEED=<n> PROP_RUNS=1 node --test sdk/test/prop-tools.test.mjs replays one iteration.
// 性质：toolsSha256 对列表顺序、任意深度的键序、JSON 文本空白、六个字段以外的成员都不敏感；对六个字段内的任何变化都敏感
// （字符串里的一个字符，含空白、大小写、NFC/NFD，数字，布尔，嵌套 schema 叶子，键名，增删成员，schema 内数组顺序）；重名拒绝。
// 摘要还等于一个独立计算。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { toolsDigest, normalizeTools, TOOL_DIGEST_FIELDS } from '../src/mcp.js'
import { forAll, runsOf, seedOf } from './helpers/prng.mjs'

const FIELDS = ['name', 'title', 'description', 'inputSchema', 'outputSchema', 'annotations']
// Values RFC 8785 serialises without question: strings, booleans, null, safe integers, nested. / 无歧义可规范化的值。
function value(r, depth = 0) {
  const k = r.int(depth > 2 ? 4 : 6)
  if (k === 0) return r.text(10)
  if (k === 1) return r.int(2_000_000) - 1_000_000
  if (k === 2) return r.bool()
  if (k === 3) return null
  if (k === 4) return Array.from({ length: 1 + r.int(3) }, () => value(r, depth + 1))
  return obj(r, depth + 1)
}
function obj(r, depth = 0) {
  const o = {}
  for (let i = 0; i < 1 + r.int(4); i++) o[r.text(6)] = value(r, depth)
  return o
}
function drawTool(r, name) {
  const t = { name }
  if (r.p(0.6)) t.title = r.text(20)
  if (r.p(0.8)) t.description = r.text(60)
  t.inputSchema = { type: 'object', properties: obj(r), ...(r.p(0.5) ? { required: [r.text(4)] } : {}) }
  if (r.p(0.4)) t.outputSchema = { type: 'object', properties: obj(r) }
  if (r.p(0.4)) t.annotations = { readOnlyHint: r.bool(), ...(r.p(0.5) ? { title: r.text(8) } : {}) }
  // outside the digest / 不在摘要内
  if (r.p(0.4)) t.icons = [{ src: 'https://x.example/' + r.int(100) + '.png' }]
  if (r.p(0.4)) t._meta = obj(r)
  if (r.p(0.2)) t.execution = { taskSupport: r.pick(['forbidden', 'optional']) }
  return t
}
function drawList(r) {
  const n = 1 + r.int(6), names = new Set()
  while (names.size < n) names.add(r.p(0.2) ? r.pick(['é', 'é', 'Z', 'a', '😀', 'ä']) + r.text(3) : r.text(8))
  return [...names].map((nm) => drawTool(r, nm))
}
const shuffleKeys = (r, v) => (Array.isArray(v) ? v.map((x) => shuffleKeys(r, x)) : v && typeof v === 'object' ? Object.fromEntries(r.shuffle(Object.entries(v)).map(([k, x]) => [k, shuffleKeys(r, x)])) : v)
const clone = (v) => JSON.parse(JSON.stringify(v))
function looseText(r, v) {
  const ws = () => r.pick(['', '', ' ', '\n', '\t', '\r\n  '])
  const go = (x) => Array.isArray(x) ? `[${ws()}${x.map((y) => ws() + go(y) + ws()).join(',')}]` : x && typeof x === 'object' ? `{${ws()}${Object.entries(x).map(([k, y]) => `${ws()}${JSON.stringify(k)}${ws()}:${ws()}${go(y)}`).join(',')}${ws()}}` : JSON.stringify(x)
  return ws() + go(v) + ws()
}
// Independent: code-unit order (the default sort of JS strings), sorted keys, no whitespace. / 独立实现。
const stable = (v) => (Array.isArray(v) ? `[${v.map(stable).join(',')}]` : v && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}` : JSON.stringify(v))
const independent = (tools) => createHash('sha256').update(stable(tools.map((t) => Object.fromEntries(FIELDS.filter((k) => t[k] !== undefined).map((k) => [k, t[k]]))).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)))).digest('hex')

// All the paths to a leaf or a member inside the digest-covered fields. / 摘要字段内的全部路径。
function paths(v, at = []) {
  if (Array.isArray(v)) return [at, ...v.flatMap((x, i) => paths(x, [...at, i]))]
  if (v && typeof v === 'object') return [at, ...Object.entries(v).flatMap(([k, x]) => paths(x, [...at, k]))]
  return [at]
}
const get = (v, p) => p.reduce((o, k) => o[k], v)
// One change inside the digest; returns a description. / 摘要内的一处改动。
function mutate(r, tools) {
  const ti = r.int(tools.length), t = tools[ti]
  const covered = FIELDS.filter((k) => t[k] !== undefined && k !== 'name')
  const choice = r.int(8)
  if (choice === 0) { const old = t.name; t.name = old + r.pick([' ', 'x', ' ']); return `name ${JSON.stringify(old)} -> ${JSON.stringify(t.name)}` }
  if (choice === 1) { const k = r.pick(FIELDS.filter((x) => t[x] === undefined) .concat(['title'])); if (t[k] !== undefined) { delete t[k]; return `removed ${k}` } t[k] = k.endsWith('Schema') ? { type: 'object' } : k === 'annotations' ? { readOnlyHint: true } : 'x'; return `added ${k}` }
  const field = r.pick(covered)
  const all = paths(t[field]).map((p) => [field, ...p])
  const p = r.pick(all)
  const parent = p.length > 1 ? get(t, p.slice(0, -1)) : t, key = p[p.length - 1], cur = get(t, p)
  if (typeof cur === 'string') {
    const i = r.int(cur.length + 1)
    const edits = [cur.slice(0, i) + ' ' + cur.slice(i), cur.toUpperCase() === cur ? cur + 'a' : cur.toUpperCase(), cur.normalize('NFD') !== cur ? cur.normalize('NFD') : cur + '́', cur.slice(0, i) + '\n' + cur.slice(i)]
    parent[key] = r.pick(edits.filter((e) => e !== cur))
    return `string at ${p.join('.')}`
  }
  if (typeof cur === 'number') { parent[key] = cur + 1; return `number at ${p.join('.')}` }
  if (typeof cur === 'boolean') { parent[key] = !cur; return `boolean at ${p.join('.')}` }
  if (cur === null) { parent[key] = 0; return `null at ${p.join('.')}` }
  if (Array.isArray(cur)) { if (cur.length > 1 && stable(cur[0]) !== stable(cur[cur.length - 1])) { cur.reverse(); return `array order at ${p.join('.')}` } cur.push('extra'); return `array grew at ${p.join('.')}` }
  // an object: rename a key or add one / 对象：改键名或加键
  const keys = Object.keys(cur)
  if (keys.length && r.bool()) { const k = r.pick(keys); const nk = k + '_'; if (!(nk in cur)) { cur[nk] = cur[k]; delete cur[k]; return `key renamed at ${p.join('.')}` } }
  cur['added_' + r.int(1000)] = 1
  return `member added at ${p.join('.')}`
}

test(`property (c): toolsSha256 ignores list order, key order, whitespace and members outside the six; changes with any change inside them; refuses a repeated name (${runsOf()} iterations, seed ${seedOf(0xc1)})`, async () => {
  assert.deepEqual([...TOOL_DIGEST_FIELDS], FIELDS, 'the six fields of TAPI-20 §3.8')
  await forAll(import.meta.url, (r) => {
    const tools = drawList(r)
    const d = toolsDigest(tools)
    assert.match(d, /^[0-9a-f]{64}$/)
    assert.equal(d, independent(tools), 'the digest equals the independent computation')
    // insensitive / 不敏感
    assert.equal(toolsDigest(r.shuffle(tools)), d, 'list order')
    assert.equal(toolsDigest(shuffleKeys(r, tools)), d, 'key order at every depth')
    assert.equal(toolsDigest(JSON.parse(looseText(r, tools))), d, 'whitespace of the JSON text')
    const extra = clone(tools).map((t) => ({ ...t, icons: [{ src: 'data:,' + r.int(9) }], _meta: { [r.text(4)]: r.text(5) }, [`x-${r.int(99)}`]: r.text(3) }))
    assert.equal(toolsDigest(extra), d, 'members outside the six')
    assert.deepEqual(normalizeTools(normalizeTools(tools)), normalizeTools(tools), 'normalising is idempotent')
    // sensitive / 敏感
    const changed = clone(tools)
    const what = mutate(r, changed)
    if (stable(normalizeTools(changed)) !== stable(normalizeTools(tools))) assert.notEqual(toolsDigest(changed), d, `the digest must change: ${what}`)
    else assert.fail(`the mutation changed nothing inside the six (${what}): generator problem`)
    // a repeated name / 重名
    const dup = [...clone(tools), { ...clone(r.pick(tools)), description: 'another' }]
    assert.throws(() => toolsDigest(dup), /appears twice/)
  }, { seed: seedOf(0xc1) })
})
