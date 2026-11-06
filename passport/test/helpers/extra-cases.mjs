// TapeAPI's own cases for gaps the prototype found in the draft's vectors (2026-10-28), NOT part of the draft: capital
// Cyrillic / Greek look-alikes, code points above U+FFFF in a member name, and decimal literals in a registration
// file (56 vs 56.0). Each expected value was checked against the draft's reference verifier passport.py (Python 3.9.6,
// cae25e6) when it was written; the test does not run Python. They are built from the draft's confirmed-by-agent
// snapshot with the registration file replaced (fileInfo's size and SHA-256 recomputed).
// TapeAPI 自己补的用例（不属于草案）：大写西里尔/希腊形近字、成员名里 U+FFFF 以上的码点、登记文件里的小数字面量（56 与 56.0）。
// 每个预期值写入时都用草案参考验证器 passport.py 核对过；测试本身不运行 Python。
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

export const V = JSON.parse(readFileSync(new URL('../fixtures/vectors.json', import.meta.url), 'utf8'))

/** Forbidden-name cases: [name, forbidden]. / 禁用名用例。 */
export const EXTRA_NAMES = [
  ['Рoints', true],          // Рoints: U+0420 CYRILLIC CAPITAL LETTER ER, then "oints"
  ['Ρrice', true],           // Ρrice: U+03A1 GREEK CAPITAL LETTER RHO
  ['Τier', true],            // Τier: U+03A4 GREEK CAPITAL LETTER TAU
  ['Вonus', true],           // Вonus: U+0412 CYRILLIC CAPITAL LETTER VE
  ['myКind', false],         // myКind: "mykind", not forbidden
  ['Рlain', false],          // Рlain: "plain"
  ['rank\u{20000}', true],        // "rank" then U+20000 (a letter above U+FFFF): a separate segment, so "rank" is one
  ['\u{20000}tier\u{20000}', true],
  ['ranking\u{20000}', false],    // segment "ranking" is not "rank"; "ranking" contains no forbidden word
]

const hex = (b) => '0x' + Buffer.from(b).toString('hex')
const word = (n) => BigInt(n).toString(16).padStart(64, '0')
/** ABI `bytes` return data for read(container, key). */
const abiBytes = (b) => '0x' + word(32) + word(b.length) + Buffer.from(b).toString('hex').padEnd(Math.ceil(b.length / 32) * 64, '0')

/** A copy of a snapshot whose registration file is `text` (fileInfo size and SHA-256 recomputed). / 换掉登记文件的快照副本。 */
export function withRegistrationFile(snap, text) {
  const s = structuredClone(snap)
  const bytes = Buffer.from(text, 'utf8')
  const info = Object.keys(s.answers).find((k) => k.includes('.fileInfo(') && k.endsWith(',.well-known/agent-registration.json)'))
  const read = Object.keys(s.answers).find((k) => k.includes('.read(') && k.endsWith(',.well-known/agent-registration.json)'))
  const old = s.answers[info].slice(2)
  // fileInfo: (uint256 size, string contentType, bytes32 sha256, uint64 updatedAt, uint256 chunkCount): words 0 and 2
  const sha = createHash('sha256').update(bytes).digest('hex')
  s.answers[info] = '0x' + word(bytes.length) + old.slice(64, 128) + sha + old.slice(192)
  s.answers[read] = abiBytes(bytes)
  return s
}
export function registrationTextOf(snap) {
  const read = Object.keys(snap.answers).find((k) => k.includes('.read(') && k.endsWith(',.well-known/agent-registration.json)'))
  const b = Buffer.from(snap.answers[read].slice(2), 'hex')
  const n = Number(BigInt('0x' + b.subarray(32, 64).toString('hex')))
  return b.subarray(64, 64 + n).toString('utf8')
}

const base = V.resolution.find((c) => c.id === 'confirmed-by-agent').snapshot
const text = registrationTextOf(base)
/** Literal substitutions in the confirmed file: [id, from, to, expected { state, reasons }]. / 对已确认文件的字面替换。 */
const EDITS = [
  ['tap-chainId-56.0', '"chainId": 56', '"chainId": 56.0', { state: 'BROKEN', reasons: ['registration-file-invalid'] }],
  ['tap-chainId-5.6e1', '"chainId": 56', '"chainId": 5.6e1', { state: 'BROKEN', reasons: ['registration-file-invalid'] }],
  ['tap-v-1.0', '"v": 1', '"v": 1.0', { state: 'CONFIRMED', reasons: [] }],   // Python: 1.0 == 1, so v 1.0 is accepted
  ['agentId-1001.0', '"agentId": 1001', '"agentId": 1001.0', { state: 'BROKEN', reasons: ['not-listed'] }],
  ['agentId-1001e0', '"agentId": 1001', '"agentId": 1001e0', { state: 'BROKEN', reasons: ['not-listed'] }],
  ['tap-cyrillic-capital-member', '"v": 1', '"v": 1, "Рoints": 1', { state: 'BROKEN', reasons: ['forbidden-name'] }],
]
export function extraResolutionCases() {
  const out = []
  for (const [id, from, to, expected] of EDITS) {
    if (!text.includes(from)) throw new Error(`${id}: "${from}" is not in the confirmed file`)
    out.push({ id, snapshot: withRegistrationFile(base, text.replace(from, to)), expected })
  }
  return out
}
export { hex }
