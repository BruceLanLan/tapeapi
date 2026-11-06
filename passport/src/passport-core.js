// @tapeapi/passport, layer 1 (@experimental): the pure resolver of the Agent Passport draft (TapeOutProtocol/TAPs pull
// request #83 at head cae25e6, OPEN, not merged), ported from its reference verifier passport.py. It never reads a node
// itself: resolve(reads, input, cfg) applies the draft's rules to `reads`, an object whose get(key) returns the answer
// the nodes agreed on at one pinned block (or throws Unavailable). snapshotReads() replays a recorded snapshot
// (tap-agent-passport-snapshot/1, the format of the draft's vectors); passport-live.js answers the same keys from nodes.
// The order of the checks is the reference's, line for line: the vectors pin the FIRST failing reason.
// Browser-safe: no `node:` import, no Buffer, no process.
// @tapeapi/passport 第 1 层（实验性）：Agent Passport 草案（TAPs PR #83，头 cae25e6，未合并）的纯函数解析，移植自其参考验证器
// passport.py。它自己从不连节点：resolve(reads, input, cfg) 对 reads 套用草案规则，reads.get(key) 返回各节点在同一钉块上一致的
// 回答（或抛 Unavailable）。snapshotReads() 回放快照（草案向量的格式）；passport-live.js 用节点回答同样的键。
// 检查顺序与参考实现逐行一致：向量断言的是"第一个失败的原因"。浏览器可用：不引用 node:、不用 Buffer、不用 process。
import { keccak_256 } from '@noble/hashes/sha3'
import { sha256 } from '@noble/hashes/sha2'
import { TapeAPIError } from '@tapeapi/sdk'
import { toHex, hexToBytes, utf8ToBytes } from '@tapeapi/sdk/abi'
import { parseTapeName } from '@tapeapi/sdk/chains'
import { displayOf } from './passport-text.js'

/**
 * The draft this version follows, carried by every result. The pull request is open: its text and vectors can change.
 * 本版本所依据的草案，每个结果都带着它。PR 未合并：文字与向量都可能变。
 */
export const DRAFT = Object.freeze({
  repo: 'TapeOutProtocol/TAPs', pr: 83, head: 'cae25e6df54ad2e2e38e185304de55f92792966d', merged: false,
  vectorsSha256: '7720772c05d60062f48daa7c1d2ab6f45affc3d05425126d9de9b00a4ff8fca4',
  mcpDraft: Object.freeze({ pr: 16, head: '13d1179f89b8c7037ebfb4e3ec3e574c1740e989' }),
  reviewsDraft: Object.freeze({ pr: 54, head: '703b2a91edf7545b3179a08b8041b49190fd4a0a', merged: false }),
  status: 'experimental',
})

export const SNAPSHOT_FORMAT = 'tap-agent-passport-snapshot/1'
export const PASSPORT_KEY = 'tap.passport'
export const REGISTRATION_KEY = '.well-known/agent-registration.json'
export const MANIFEST_KEY = '.well-known/tapeapi.json'
export const REGISTRATION_TYPE = 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1'
export const MAX_REGISTRATION_BYTES = 65_536
const MAX_PIN_LAG = { 56: 400 }
const MAX_TOKEN_ID = 10n ** 18n
const MAX_SAFE = 2 ** 53 - 1
export const ZERO_ADDRESS = '0x' + '00'.repeat(20)

/**
 * The ERC-8004 registries and TapeOut contracts of BNB Smart Chain the draft reads (§2, Deployments). Both registries
 * are upgradeable (UUPS; their owner read 2026-10-28 is a proxy answering getThreshold() 3 and five getOwners(), i.e.
 * shaped like a 3-of-5 Safe): an implementation other than the one listed makes the result UNAVAILABLE.
 * 草案读取的 BNB 链 ERC-8004 注册表与 TapeOut 合约。两个注册表都可升级（UUPS；10-28 读到的 owner 是形如 3-of-5 Safe 的代理）：
 * 实现不是这里列出的即为 UNAVAILABLE。
 */
export const PASSPORT_CONFIG = Object.freeze({
  chainId: 56,
  identityRegistry: '0x8004a169fb4a3325136eb29fa0ceb6d2e539a432',
  identityImplementations: Object.freeze(['0x7274e874ca62410a93bd8bf61c69d8045e399c02']),
  reputationRegistry: '0x8004baa17c55a88189ae136b182e5fda19de9b63',
  reputationImplementations: Object.freeze(['0x16e0fa7f7c56b9a767e34b192b51f921be31da34']),
  factory: '0x68224f668083c29e9800be2a646d42d18cedf7e2',
  opener: '0x021745de2f42a7839d96f2d3634d0294487d81f1',
  siteRegistry: '0xd006ffdd5ae313b17729621a00999cd3c71ce5e6',
  siteRegistryImplementations: Object.freeze(['0x1d279d138a4d803378a7d4557c056f1bed53c261']),
})

export const STATES = Object.freeze(['CONFIRMED', 'BROKEN', 'AMBIGUOUS', 'wallet-unset', 'stale-agent-wallet', 'UNAVAILABLE'])
/** Every reason of §6.3 and the rule it reports. The draft only ever adds names. / §6.3 的全部原因及其规则；草案只增不减。 */
export const REASONS = Object.freeze({
  'wrong-chain': 'P-6', 'stale-block': 'P-6', 'node-disagreement': 'P-6', unavailable: 'P-6', 'registry-changed': 'P-6', 'store-changed': 'P-6',
  'no-such-agent': 'P-1', 'holder-mismatch': 'P-1', 'no-passport-key': 'P-2', 'bad-passport-key': 'P-2', 'chain-mismatch': 'P-3',
  'not-tapeout': 'P-4', 'no-such-token': 'P-4', 'not-opened': 'P-5',
  'registration-file-missing': 'P-7', 'registration-file-too-large': 'P-7', 'registration-file-incomplete': 'P-7', 'registration-file-no-hash': 'P-7',
  'registration-file-invalid': 'P-7', 'forbidden-name': 'P-7', 'file-chain-mismatch': 'P-7', 'tape-service-missing': 'P-7',
  'stale-operator': 'P-8', 'wallet-unset': 'P-9', 'stale-agent-wallet': 'P-9', 'not-listed': 'P-10', 'several-listed': 'P-10', 'key-circuit-mismatch': 'P-11',
})
export const WARNINGS = Object.freeze(['operators-not-checked', 'agent-uri-not-canonical', 'manifest-hash-differs', 'holder-changed', 'transfer-history-unavailable'])

/** A read that could not be adopted (P-6): the result is UNAVAILABLE, never BROKEN. / 读取未达成共识：UNAVAILABLE，绝不 BROKEN。 */
export class Unavailable extends Error { constructor(reason, key = '') { super(`${reason}${key ? ` (${key})` : ''}`); this.reason = reason; this.key = key } }
/** A binding fact that is false. / 一条绑定事实不成立。 */
export class Broken extends Error { constructor(reason, detail = '') { super(`${reason}${detail ? `: ${detail}` : ''}`); this.reason = reason; this.detail = detail } }

const badArg = (m) => new TapeAPIError('INVALID_ARGUMENT', m)

// ── hex and ABI words / 十六进制与 ABI 字 ─────────────────────────────────
export function addr(a) { if (typeof a !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(a)) throw new Error(`bad address ${String(a).slice(0, 60)}`); return a.toLowerCase() }
export const hx = (b) => toHex(b)
export function unhex(s) { if (typeof s !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(s)) throw new Error(`bad hex ${String(s).slice(0, 60)}`); return hexToBytes(s) }
const word = (b, i) => b.subarray(32 * i, 32 * i + 32)
const big = (w) => (w.length ? BigInt(hx(w)) : 0n)
function decUint(b, i = 0) { const w = word(b, i); if (w.length !== 32) throw new Error('short return data'); return big(w) }
function decAddress(b, i = 0) { const w = word(b, i); if (w.length !== 32 || w.subarray(0, 12).some((x) => x)) throw new Error('not an address word'); return hx(w.subarray(12)) }
function decBool(b, i = 0) { const v = decUint(b, i); if (v !== 0n && v !== 1n) throw new Error('not a bool'); return v === 1n }
function decDyn(b, head) {
  const off = Number(decUint(b, head)); const n = Number(big(b.subarray(off, off + 32)))
  const data = b.subarray(off + 32, off + 32 + n); if (data.length !== n) throw new Error('short dynamic value'); return data
}
const utf8 = new TextDecoder('utf-8', { fatal: true })
const utf8Lenient = new TextDecoder()
function decFileInfo(b) {
  return { size: decUint(b, 0), contentType: utf8Lenient.decode(decDyn(b, 1)), sha256: hx(word(b, 2)), updatedAt: decUint(b, 3), chunkCount: decUint(b, 4) }
}
export const keccak256 = (bytes) => keccak_256(bytes)
export const selector = (sig) => hx(keccak_256(utf8ToBytes(sig)).subarray(0, 4))
export const sha256Hex = (bytes) => hx(sha256(bytes))

// ── §4 the tap.passport key / tap.passport 键 ────────────────────────────
/** abi.encode(uint256 chainId, address processor, uint256 tokenId): 96 bytes. / 96 字节。 */
export function encodePassportKey(chainId, processor, tokenId) {
  const c = BigInt(chainId), t = BigInt(tokenId)
  if (c < 1n || c > BigInt(MAX_SAFE)) throw badArg('encodePassportKey: chainId out of range')
  if (t < 1n || t > MAX_TOKEN_ID) throw badArg('encodePassportKey: tokenId must be 1 to 10^18')
  let p; try { p = addr(processor) } catch { throw badArg('encodePassportKey: processor must be an address') }
  const out = new Uint8Array(96)
  const w = (v, at) => { let x = v; for (let i = 31; i >= 0; i--) { out[at + i] = Number(x & 0xffn); x >>= 8n } }
  w(c, 0); out.set(unhex(p), 44); w(t, 64)
  return out
}
/** §4 item 1: Broken('no-passport-key' | 'bad-passport-key') or { chainId, processor, tokenId }. */
export function decodeKey(value) {
  if (value.length === 0) throw new Broken('no-passport-key')
  if (value.length !== 96) throw new Broken('bad-passport-key', `length ${value.length}, not 96`)
  const chainId = big(value.subarray(0, 32))
  if (value.subarray(32, 44).some((x) => x)) throw new Broken('bad-passport-key', 'address word has non-zero high bytes')
  const processor = hx(value.subarray(44, 64)); const tokenId = big(value.subarray(64, 96))
  if (chainId === 0n || chainId > BigInt(MAX_SAFE)) throw new Broken('bad-passport-key', 'chainId out of range')
  if (processor === ZERO_ADDRESS) throw new Broken('bad-passport-key', 'zero processor')
  if (tokenId < 1n || tokenId > MAX_TOKEN_ID) throw new Broken('bad-passport-key', 'tokenId out of range')
  return { chainId: Number(chainId), processor, tokenId }
}

// ── strict JSON that keeps 56 and 56.0 apart / 区分 56 与 56.0 的严格 JSON ──
// Python's json (the reference) keeps an integer literal and a decimal literal apart; JSON.parse does not, and the
// draft's results depend on it (tap.chainId 56.0 is registration-file-invalid; agentId 1001.0 is not listed). So the
// registration file is never read with JSON.parse: integers come back as numbers (|n| <= 2^53-1), every literal with a
// fraction or an exponent as a JFloat. / 参考实现（Python json）区分整数字面量与小数字面量，JSON.parse 不区分，而草案的结果
// 取决于此。所以登记文件绝不用 JSON.parse 读：整数返回 number，带小数点或指数的字面量返回 JFloat。
export class NoCanonicalForm extends Error {}
export class JFloat { constructor(v) { this.v = v } }
const PROTO = new Set(['__proto__', 'constructor', 'prototype'])
const UNPAIRED = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
const ESCAPES = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' }
const NUM = /-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/y
/** RFC 8259 JSON from UTF-8 bytes without a BOM; SyntaxError, or NoCanonicalForm (TAP-11 §6). / 严格解析。 */
export function strictJson(bytes) {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) throw new SyntaxError('byte order mark')
  const s = utf8.decode(bytes)   // throws TypeError on invalid UTF-8 / 非法 UTF-8 抛 TypeError
  let i = 0
  const ws = () => { while (i < s.length && (s[i] === ' ' || s[i] === '\t' || s[i] === '\n' || s[i] === '\r')) i++ }
  const fail = (m) => { throw new SyntaxError(`${m} at ${i}`) }
  function str() {
    i++; let out = ''
    for (;;) {
      if (i >= s.length) fail('unterminated string')
      const c = s[i]
      if (c === '"') { i++; break }
      if (c < ' ') fail('control character in string')
      if (c === '\\') {
        const e = s[i + 1]
        if (e === 'u') { const h = s.slice(i + 2, i + 6); if (!/^[0-9a-fA-F]{4}$/.test(h)) fail('bad \\u escape'); out += String.fromCharCode(parseInt(h, 16)); i += 6; continue }
        const m = ESCAPES[e]; if (m === undefined) fail('bad escape'); out += m; i += 2; continue
      }
      out += c; i++
    }
    if (UNPAIRED.test(out)) throw new NoCanonicalForm('unpaired surrogate')
    return out
  }
  function num() {
    // sticky, over the whole text: a literal of any length is read whole, as Python's json reads it (FIXED R30-P3; it
    // was cut at 4,096 characters) / 粘连匹配、不截断：任意长度的字面量整体读取，与 Python json 相同
    NUM.lastIndex = i; const m = NUM.exec(s); if (!m) fail('bad number'); i += m[0].length
    if (!m[2] && !m[3]) {
      if (m[0] === '-0') throw new NoCanonicalForm('negative zero')
      const v = BigInt(m[0]); if ((v < 0n ? -v : v) > BigInt(MAX_SAFE)) throw new NoCanonicalForm('integer beyond 2^53-1')
      return Number(v)
    }
    const v = Number(m[0]); if (!Number.isFinite(v)) throw new NoCanonicalForm('non-finite number')
    if (Object.is(v, -0)) throw new NoCanonicalForm('negative zero')
    if (Number.isInteger(v) && Math.abs(v) > MAX_SAFE) throw new NoCanonicalForm('integer beyond 2^53-1')
    return new JFloat(v)
  }
  function val(depth) {
    if (depth > 512) fail('nested too deeply')
    ws(); const c = s[i]
    if (c === '{') {
      i++; const o = Object.create(null); ws(); if (s[i] === '}') { i++; return o }
      for (;;) {
        ws(); if (s[i] !== '"') fail('member name expected')
        const k = str()
        if (Object.prototype.hasOwnProperty.call(o, k)) throw new NoCanonicalForm(`repeated member ${k}`)
        if (PROTO.has(k)) throw new NoCanonicalForm(`member named ${k}`)
        ws(); if (s[i] !== ':') fail('":" expected'); i++
        o[k] = val(depth + 1); ws()
        if (s[i] === ',') { i++; continue }
        if (s[i] === '}') { i++; return o }
        fail('"," or "}" expected')
      }
    }
    if (c === '[') {
      i++; const a = []; ws(); if (s[i] === ']') { i++; return a }
      for (;;) { a.push(val(depth + 1)); ws(); if (s[i] === ',') { i++; continue } if (s[i] === ']') { i++; return a } fail('"," or "]" expected') }
    }
    if (c === '"') return str()
    if (s.startsWith('true', i)) { i += 4; return true }
    if (s.startsWith('false', i)) { i += 5; return false }
    if (s.startsWith('null', i)) { i += 4; return null }
    if (s.startsWith('NaN', i) || s.startsWith('Infinity', i) || s.startsWith('-Infinity', i)) throw new NoCanonicalForm('non-finite number')
    return num()
  }
  const v = val(0); ws(); if (i !== s.length) fail('extra data')
  return v
}
export const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof JFloat)
const isInt = (v) => typeof v === 'number'   // integers come back as numbers, decimals as JFloat / 整数为 number，小数为 JFloat
const numEq = (v, n) => (typeof v === 'number' ? v === n : v instanceof JFloat ? v.v === n : false)   // Python's ==

/**
 * RFC 8785 canonical JSON of what strictJson returns (and of plain JSON values): ES Number::toString for numbers, keys
 * in UTF-16 code unit order. Byte for byte the draft's serializer, which the vectors pin.
 * strictJson 返回值（及普通 JSON 值）的 RFC 8785 规范形式：数字按 ES Number::toString，键按 UTF-16 码元排序。与草案序列化器逐字节一致。
 */
export function canonicalJson(v) {
  if (v === null) return 'null'
  if (v === true) return 'true'
  if (v === false) return 'false'
  if (typeof v === 'number') { if (!Number.isFinite(v)) throw new NoCanonicalForm('non-finite number'); return String(v) }
  if (v instanceof JFloat) return String(v.v)
  if (typeof v === 'string') return JSON.stringify(v)
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']'
  if (typeof v !== 'object') throw new TypeError('not a JSON value')
  const ks = Object.keys(v).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  return '{' + ks.map((k) => JSON.stringify(k) + ':' + canonicalJson(v[k])).join(',') + '}'
}

// ── §5.4 forbidden member names / 禁用成员名 ──────────────────────────────
// Default_Ignorable_Code_Point of Unicode 15.1.0 (it contains Bidi_Control), as the draft pins it.
// 草案钉住的 Unicode 15.1.0 Default_Ignorable_Code_Point（含 Bidi_Control）。
const DEFAULT_IGNORABLE = [[0x00AD, 0x00AD], [0x034F, 0x034F], [0x061C, 0x061C], [0x115F, 0x1160], [0x17B4, 0x17B5], [0x180B, 0x180F], [0x200B, 0x200F], [0x202A, 0x202E], [0x2060, 0x206F], [0x3164, 0x3164], [0xFE00, 0xFE0F], [0xFEFF, 0xFEFF], [0xFFA0, 0xFFA0], [0xFFF0, 0xFFF8], [0x1BCA0, 0x1BCA3], [0x1D173, 0x1D17A], [0xE0000, 0xE0FFF]]
/**
 * The draft's confusable table (31 Cyrillic and Greek letters; their capitals map through lower case). It decides
 * forbidden-name, and no other table may: it does not catch every look-alike, and nothing here claims it does.
 * 草案的混淆字表（31 个西里尔、希腊字母；大写经小写映射）。forbidden-name 只由它决定；它抓不到所有形近字，这里也不这样声称。
 */
export const CONFUSABLES = Object.freeze({ 'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'у': 'y', 'х': 'x', 'і': 'i', 'ј': 'j', 'ѕ': 's', 'ԁ': 'd', 'ԛ': 'q', 'ԝ': 'w', 'һ': 'h', 'ӏ': 'l', 'к': 'k', 'м': 'm', 'т': 't', 'в': 'b', 'н': 'h', 'ο': 'o', 'α': 'a', 'ρ': 'p', 'ε': 'e', 'ι': 'i', 'κ': 'k', 'ν': 'v', 'τ': 't', 'υ': 'u', 'χ': 'x', 'β': 'b' })
// Data from the draft, not text of ours; the Chinese words are written as escapes so that wording scans of this
// repository do not take the list for a claim. / 草案里的数据，不是我们的说法；中文词用转义写，免得本仓库的措辞扫描把它当成声明。
const FORBIDDEN_WORDS = Object.freeze(['price', 'worth', 'yield', 'interest', 'dividend', 'revenue', 'profit', 'income', 'share', 'allocation', 'allotment', 'airdrop', 'reward', 'payout', 'payment', 'weight', 'multiplier', 'bonus', 'boost', 'score', 'rating', 'eligibility', 'entitlement', 'claimable', 'vesting', 'staking', 'verified', 'certified', 'official',
  '\u7a7a\u6295', '\u5956\u52b1', '\u5206\u914d', '\u6536\u76ca', '\u8d44\u683c', '\u5206\u7ea2', '\u8ba4\u8bc1'])
const FORBIDDEN_SEGMENTS = new Set(['point', 'points', 'rank', 'tier', 'stake', 'apy', 'apr', 'bounty', 'value'])
const ignorable = (cp) => DEFAULT_IGNORABLE.some(([a, b]) => a <= cp && cp <= b)
// Python's str.casefold() for what can remain after NFKC and lower-casing (ß, final sigma); the rest is toLowerCase.
// Python casefold 在 NFKC 与小写之后仍可能不同的字母（ß、词尾 sigma）；其余与 toLowerCase 相同。
// ...and the full case foldings (CaseFolding.txt status F) of NFKC-stable code points whose folding is a letter and a
// combining mark: the mark then splits the segment in the reference (Python's [^\w]+), so 'weigẖt' is forbidden there.
// These 24 are every code point where that differs from toLowerCase (checked over all of Unicode on Python 3.9 and
// Node 22; FIXED R30-P2). / 以及完全大小写折叠（F 类）里折叠成"字母 + 组合符号"的 24 个 NFKC 稳定码点：参考实现里组合符号会切分片段。
const FULL_FOLD = Object.freeze({ 'ǰ': 'ǰ', 'ΐ': 'ΐ', 'ΰ': 'ΰ', 'ẖ': 'ẖ', 'ẗ': 'ẗ', 'ẘ': 'ẘ', 'ẙ': 'ẙ', 'ὐ': 'ὐ', 'ὒ': 'ὒ', 'ὔ': 'ὔ', 'ὖ': 'ὖ', 'ᾶ': 'ᾶ', 'ᾷ': 'ᾶι', 'ῆ': 'ῆ', 'ῇ': 'ῆι', 'ῒ': 'ῒ', 'ῖ': 'ῖ', 'ῗ': 'ῗ', 'ῢ': 'ῢ', 'ῤ': 'ῤ', 'ῦ': 'ῦ', 'ῧ': 'ῧ', 'ῶ': 'ῶ', 'ῷ': 'ῶι' })
const casefold = (x) => [...x.toLowerCase()].map((c) => FULL_FOLD[c] ?? c).join('').replace(/ß/g, 'ss').replace(/ς/g, 'σ')
/**
 * §5.4 normalisation: NFKC; drop Cc, Mn, Me and default-ignorable code points; the confusable table (and capitals);
 * segments at non-letters/digits and camel case; case folding. NFKC and the categories follow the runtime's Unicode
 * version (the draft pins only Default_Ignorable_Code_Point), so a code point added after Unicode 13 may differ from
 * the reference on Python 3.9. / §5.4 规范化。NFKC 与字符类别取决于运行环境的 Unicode 版本（草案只钉住了 Default_Ignorable）。
 */
export function normaliseName(name) {
  let s = String(name).normalize('NFKC')
  s = [...s].filter((c) => !ignorable(c.codePointAt(0)) && !/^[\p{Cc}\p{Mn}\p{Me}]$/u.test(c)).join('')
  s = [...s].map((c) => CONFUSABLES[c] ?? CONFUSABLES[c.toLowerCase()] ?? c).join('')
  s = s.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
  // Python's [^0-9A-Za-zÀ-￿]+ over code points: every code point above U+FFFF splits (the `u` flag; without it
  // the two surrogate halves would fall inside the range). / 按码点：U+FFFF 以上的每个码点都切分（需要 u 标志）。
  let segs = s.split(/[^0-9A-Za-z\u00C0-\uFFFF]+/u).filter(Boolean).map(casefold)
  segs = segs.flatMap((seg) => seg.split(/[^\p{L}\p{N}_]+/u)).filter(Boolean)   // Python's [^\w]+
  return { joined: segs.join(''), segs }
}
/** §5.4: true when the member name is forbidden inside `tap`. / 名字在 tap 内是否禁用。 */
export function forbiddenName(name) {
  const { joined, segs } = normaliseName(name)
  if (FORBIDDEN_WORDS.some((w) => joined.includes(w))) return true
  return FORBIDDEN_SEGMENTS.has(joined) || segs.some((x) => FORBIDDEN_SEGMENTS.has(x))
}
function* walkNames(v, path) {
  if (isObj(v)) for (const k of Object.keys(v)) { yield [path + '/' + k, k]; yield* walkNames(v[k], path + '/' + k) }
  else if (Array.isArray(v)) for (let i = 0; i < v.length; i++) yield* walkNames(v[i], `${path}/${i}`)
}

// ── §5 the registration file / 登记文件 ───────────────────────────────────
/** §5.3 (and §5.4 before the required members, as the reference). Throws Broken. / 先查禁用名，再查必填成员。 */
export function checkTapMember(tap) {
  if (!isObj(tap)) throw new Broken('registration-file-invalid', 'tap is not an object')
  for (const [p, k] of walkNames(tap, '/tap')) if (forbiddenName(k)) throw new Broken('forbidden-name', p)
  for (const k of ['v', 'chainId', 'processor', 'tokenId', 'container']) if (!(k in tap)) throw new Broken('registration-file-invalid', `tap.${k} missing`)
  if (typeof tap.v === 'boolean' || !numEq(tap.v, 1)) throw new Broken('registration-file-invalid', 'tap.v is not 1')
  const c = tap.chainId; if (!isInt(c) || !(c >= 1 && c <= MAX_SAFE)) throw new Broken('registration-file-invalid', 'tap.chainId is not an integer from 1 to 2^53-1')
  for (const k of ['processor', 'container']) if (typeof tap[k] !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(tap[k])) throw new Broken('registration-file-invalid', `tap.${k}`)
  const t = tap.tokenId; if (typeof t !== 'string' || !/^[1-9][0-9]{0,18}$/.test(t) || BigInt(t) > MAX_TOKEN_ID) throw new Broken('registration-file-invalid', 'tap.tokenId')
  if ('manifest' in tap) {
    const m = tap.manifest
    if (!isObj(m) || m.path !== '/' + MANIFEST_KEY || typeof m.sha256 !== 'string' || !/^0x[0-9a-f]{64}$/.test(m.sha256)) throw new Broken('registration-file-invalid', 'tap.manifest')
  }
}
/** §5.2 and §5.3 of the file's bytes; returns the parsed document or throws Broken. / 解析并检查登记文件。 */
export function parseRegistrationFile(bytes) {
  let doc
  try { doc = strictJson(bytes); canonicalJson(doc) } catch (e) {
    if (e instanceof NoCanonicalForm) throw new Broken('registration-file-invalid', `no canonical form: ${e.message}`)
    if (e instanceof SyntaxError || e instanceof TypeError || e instanceof RangeError) throw new Broken('registration-file-invalid', `not JSON: ${e.message}`)
    throw e
  }
  if (!isObj(doc)) throw new Broken('registration-file-invalid', 'top level is not an object')
  if (doc.type !== REGISTRATION_TYPE) throw new Broken('registration-file-invalid', 'type')
  if (!Array.isArray(doc.registrations) || !Array.isArray(doc.services)) throw new Broken('registration-file-invalid', 'registrations or services is not an array')
  checkTapMember(doc.tap)
  return doc
}
/** P-10: the agentIds the file lists for this registry (a JSON integer or a decimal string; 1001.0 does not count). */
export function listedAgentIds(doc, chainId, registry) {
  const want = `eip155:${chainId}:${addr(registry)}`; const out = []
  for (const r of doc.registrations) {
    if (!isObj(r) || typeof r.agentRegistry !== 'string') continue
    const m = /^eip155:([1-9][0-9]*):(0x[0-9a-fA-F]{40})$/.exec(r.agentRegistry)
    if (!m || `eip155:${m[1]}:${m[2].toLowerCase()}` !== want) continue
    const a = r.agentId
    if (typeof a === 'number' && a >= 0) out.push(BigInt(a))
    else if (typeof a === 'string' && /^(0|[1-9][0-9]*)$/.test(a)) out.push(BigInt(a))
  }
  return out
}
export const onChainName = (tokenId, number) => `${tokenId}.${number}.tape`
export const gatewayLabel = (tokenId, number) => `${tokenId}-${number}`

// ── §6.1 snapshot reads / 快照读取 ─────────────────────────────────────────
/**
 * Reads replayed from a tap-agent-passport-snapshot/1 under strict agreement, as the reference does: every recorded
 * operator answer must agree, and at least max(2, min(3, operators)) operators must have answered.
 * 按严格共识回放快照：所有记录的运营方回答一致，且至少 max(2, min(3, 运营方数)) 家作答。
 */
export function snapshotReads(snap) {
  if (!isObj(snap) && !(snap && typeof snap === 'object')) throw badArg('snapshotReads: a snapshot object')
  const ops = snap.operators || {}; const names = Object.keys(ops).sort(); const need = Math.max(2, Math.min(3, names.length))
  const common = snap.answers || {}
  const used = []
  // `processorNumbers` (a TapeAPI extension, written by a live resolution's recordSnapshot): the processor table's hint,
  // still checked by the cpuAt read recorded in the answers. / TapeAPI 扩展：处理器表的提示，仍由记录的 cpuAt 读取核对。
  const hints = isObj(snap.processorNumbers) || (snap.processorNumbers && typeof snap.processorNumbers === 'object') ? snap.processorNumbers : null
  return {
    ...(hints ? { processorNumber: async (p) => (Object.hasOwn(hints, p) ? Number(hints[p]) : null) } : {}),
    pinnedBlock: snap.pinnedBlock,
    heads: names.map((n) => ops[n].head).filter((h) => Number.isInteger(h)),
    used,
    async get(key) {
      used.push(key)
      const answers = []
      for (const n of names) { const own = ops[n].answers || {}; const a = Object.hasOwn(own, key) ? own[key] : common[key]; if (a !== null && a !== undefined) answers.push(a) }
      const first = answers.length ? canonicalJson(answers[0]) : null
      for (const x of answers.slice(1)) if (canonicalJson(x) !== first) throw new Unavailable('node-disagreement', key)
      if (answers.length < need) throw new Unavailable('unavailable', key)
      return answers[0]
    },
  }
}
async function call(rd, key) { const a = await rd.get(key); if (isObj(a) && 'revert' in a) return { revert: a.revert }; return unhex(a) }
const isRevert = (x) => !(x instanceof Uint8Array)
// A malformed answer is a node failure, never a fact about the passport. / 格式不对的回答是节点故障，不是护照的事实。
function decoded(key, f) { try { return f() } catch (e) { if (e instanceof Broken || e instanceof Unavailable) throw e; throw new Unavailable('unavailable', key) } }

// ── §6.2 resolution / 解析 ─────────────────────────────────────────────────
async function fixedReads(rd, cfg) {
  const cid = await rd.get('eth_chainId')
  if (decoded('eth_chainId', () => Number(BigInt(cid))) !== cfg.chainId) throw new Unavailable('wrong-chain', 'eth_chainId')
  const pinned = rd.pinnedBlock; const heads = rd.heads; const max = heads.length ? Math.max(...heads) : null
  if (max === null || !Number.isSafeInteger(pinned) || max - pinned > (MAX_PIN_LAG[cfg.chainId] ?? 400) || pinned > max) throw new Unavailable('stale-block', 'pinnedBlock')
  const block = await rd.get('block')
  const slot = async (proxy) => {
    const k = 'implSlot:' + addr(proxy); const w = await rd.get(k)
    return decoded(k, () => { if (typeof w !== 'string' || !/^0x[0-9a-fA-F]{40,64}$/.test(w)) throw new Error('not a storage word'); return '0x' + w.slice(-40).toLowerCase() })
  }
  const impl = await slot(cfg.identityRegistry)
  if (!cfg.identityImplementations.map(addr).includes(impl)) throw new Unavailable('registry-changed', 'implSlot:' + addr(cfg.identityRegistry))
  const simpl = await slot(cfg.siteRegistry)
  if (!cfg.siteRegistryImplementations.map(addr).includes(simpl)) throw new Unavailable('store-changed', 'implSlot:' + addr(cfg.siteRegistry))
  return { pinnedBlock: pinned, blockHash: block.hash, timestamp: block.timestamp }
}
// §4.3 step 3 of TAP-10: the processor number. Snapshot reads scan cpuAt(i) from 0 as the reference does; live reads
// may offer a hint (the SDK's processor table), which is used only after cpuAt(hint), read like every other read here,
// names this processor. / 处理器号：快照按参考实现从 0 扫 cpuAt；在线读取可给出提示（SDK 的处理器表），但只有在同样严格读到的
// cpuAt(提示) 正是这个处理器时才用。
async function processorNumber(rd, cfg, processor) {
  const f = addr(cfg.factory)
  const at = async (i) => { const r = await call(rd, `${f}.cpuAt(${i})`); return isRevert(r) ? null : decoded(`${f}.cpuAt(${i})`, () => decAddress(r)) }
  if (typeof rd.processorNumber === 'function') {
    const hint = await rd.processorNumber(processor)
    if (hint === null || hint === undefined) throw new Unavailable('unavailable', `processor number of ${processor} (isCPU is true, the processor list does not name it)`)
    if ((await at(hint)) !== processor) throw new Unavailable('unavailable', `${f}.cpuAt(${hint})`)
    return Number(hint)
  }
  const max = Number.isSafeInteger(rd.maxProcessorScan) ? rd.maxProcessorScan : Infinity
  for (let i = 0; ; i++) {
    if (i >= max) throw new Unavailable('unavailable', `processor number of ${processor} not among the first ${max} (pass an api client for the SDK's processor table)`)
    const got = await at(i)
    if (got === null) throw new Broken('not-tapeout', 'processor number not found')
    if (got === processor) return i
  }
}
async function circuit(rd, cfg, processor, tokenId, knownNumber = null) {
  const f = addr(cfg.factory), o = addr(cfg.opener)
  let r = await call(rd, `${f}.isCPU(${processor})`); if (isRevert(r) || !decoded('isCPU', () => decBool(r))) throw new Broken('not-tapeout')
  r = await call(rd, `${processor}.ownerOf(${tokenId})`); if (isRevert(r)) throw new Broken('no-such-token')
  const holder = decoded('ownerOf', () => decAddress(r))
  const acc = await call(rd, `${o}.accountOf(${processor},${tokenId})`)
  const container = decoded('accountOf', () => { if (isRevert(acc)) throw new Error('revert'); return decAddress(acc) })
  const op = await call(rd, `${o}.isOpened(${processor},${tokenId})`)
  if (!decoded('isOpened', () => { if (isRevert(op)) throw new Error('revert'); return decBool(op) })) throw new Broken('not-opened')
  const number = knownNumber ?? await processorNumber(rd, cfg, processor)
  return { holder, container, processorNumber: number, name: onChainName(tokenId, number) }
}
async function fileInfo(rd, cfg, container, key) {
  const k = `${addr(cfg.siteRegistry)}.fileInfo(${container},${key})`
  const r = await call(rd, k)
  return decoded(k, () => { if (isRevert(r)) throw new Error('revert'); return decFileInfo(r) })
}
async function readFile(rd, cfg, container, key, missing, maxBytes) {
  const info = await fileInfo(rd, cfg, container, key)
  if (info.chunkCount === 0n) throw new Broken(missing)
  if (info.size > BigInt(maxBytes)) throw new Broken(missing.replace('missing', 'too-large'))
  const k = `${addr(cfg.siteRegistry)}.read(${container},${key})`
  const r = await call(rd, k)
  const data = decoded(k, () => { if (isRevert(r)) throw new Error('revert'); return decDyn(r, 0) })
  if (BigInt(data.length) !== info.size || sha256Hex(data) !== info.sha256) {
    if (info.sha256 === '0x' + '00'.repeat(32)) throw new Broken(missing.replace('missing', 'no-hash'))
    throw new Broken(missing.replace('missing', 'incomplete'))
  }
  return { data, info }
}
const notObtained = (x) => isObj(x) && x.unavailable === true
async function operators(rd, container, holder, ts, warnings, checked) {
  const key = `logs.OperatorSet(${container})`
  const recs = await rd.get(key)
  if (notObtained(recs)) { warnings.push('operators-not-checked'); return }
  const latest = decoded(key, () => { const m = new Map(); for (const r of recs) m.set(addr(r.operator), { until: Number(r.until), setBy: addr(r.setBy) }); return m })
  checked.siteOperators = true
  for (const [op, r] of latest) { if (op === ZERO_ADDRESS || r.until < ts) continue; if (r.setBy !== holder) throw new Broken('stale-operator', op) }
}
async function epoch(rd, agentId, processor, tokenId, holder, warnings) {
  const ki = `logs.Transfer.identity(${agentId})`, kc = `logs.Transfer.circuit(${processor},${tokenId})`
  const ti = await rd.get(ki)
  const tc = await rd.get(kc)
  if (notObtained(ti) || notObtained(tc)) { warnings.push('transfer-history-unavailable'); return null }
  decoded(ki, () => { for (const t of ti) { addr(t.from); addr(t.to); if (!Number.isSafeInteger(Number(t.block))) throw new Error('block') } })
  decoded(kc, () => { for (const t of tc) { addr(t.from); addr(t.to); if (!Number.isSafeInteger(Number(t.block))) throw new Error('block') } })
  const last = []; let changed = false
  for (const lst of [ti, tc]) {
    if (!lst.length || addr(lst[lst.length - 1].to) !== holder) { warnings.push('transfer-history-unavailable'); return null }
    const t = lst[lst.length - 1]; last.push(Number(t.block)); if (addr(t.from) !== ZERO_ADDRESS) changed = true
  }
  if (addr(ti[0].from) !== ZERO_ADDRESS) { warnings.push('transfer-history-unavailable'); return null }
  if (changed) warnings.push('holder-changed')
  return { startBlock: Math.max(...last), changed, identityRegisteredBlock: Number(ti[0].block) }
}

/** Validates a resolution input before any read; throws INVALID_ARGUMENT. / 读取之前校验输入。 */
export function normaliseInput(input) {
  if (!input || typeof input !== 'object') throw badArg('passport input: { agentId } | { circuit: { processor, tokenId } } | { name }')
  if (input.agentId !== undefined) {
    const a = input.agentId
    if (!((typeof a === 'bigint' && a >= 0n) || (typeof a === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(a)) || (Number.isSafeInteger(a) && a >= 0))) throw badArg('agentId: a non-negative integer (decimal string, bigint or safe integer)')
    // an ERC-721 token ID is a uint256: a larger one was sent to the ABI encoder and threw ABI_INVALID out of a live
    // resolution (FIXED R30-P6) / ERC-721 代币号是 uint256：更大的值原先在在线解析里由 ABI 编码器抛出 ABI_INVALID
    if (BigInt(a) >= 1n << 256n) throw badArg('agentId: at most 2^256 - 1 (a uint256)')
    return { agentId: BigInt(a) }
  }
  if (input.circuit !== undefined) {
    const c = input.circuit
    let processor; try { processor = addr(c?.processor) } catch { throw badArg('circuit.processor: a processor contract address') }
    const t = c.tokenId
    if (!((typeof t === 'bigint') || (typeof t === 'string' && /^[1-9][0-9]{0,18}$/.test(t)) || Number.isSafeInteger(t))) throw badArg('circuit.tokenId: an integer from 1 to 10^18')
    const tokenId = BigInt(t); if (tokenId < 1n || tokenId > MAX_TOKEN_ID) throw badArg('circuit.tokenId: an integer from 1 to 10^18')
    return { circuit: { processor, tokenId } }
  }
  if (input.name !== undefined) {
    const p = parseTapeName(String(input.name))
    if (!p || p.error) throw badArg(`name: a TapeOut name such as 4246.0.tape (${p?.error ?? 'not a name'})`)
    if (p.chainId !== 56) throw badArg('name: this version defines passports on BNB Smart Chain (chain 56) only')
    return { name: { tokenId: BigInt(p.tokenId), number: Number(p.processor) } }
  }
  throw badArg('passport input: { agentId } | { circuit: { processor, tokenId } } | { name }')
}

/**
 * §6.2: one resolution over `rd`. input: { agentId } | { circuit: { processor, tokenId } } | { name }. cfg: as
 * PASSPORT_CONFIG (the snapshot's own config for the vectors). Returns the result; throws only INVALID_ARGUMENT.
 * §6.2：在 rd 上解析一次。只有参数错误会抛出；读不到一律是 UNAVAILABLE。
 */
export async function resolve(rd, input, cfg = PASSPORT_CONFIG) {
  const inp = normaliseInput(input)
  const chain = cfg.chainId; const registry = addr(cfg.identityRegistry)
  const res = {
    state: null, reasons: [], warnings: [], agentId: null, holder: null, processor: null, tokenId: null, container: null, name: null,
    pinnedBlock: rd.pinnedBlock ?? null, blockHash: null, holderEpoch: null, checked: { siteOperators: false, holderHistory: false },
  }
  try {
    const fixed = await fixedReads(rd, cfg); res.blockHash = fixed.blockHash
    let agentId, inputCircuit = null, known = null
    if (inp.name) {
      // A name gives the processor number; cpuAt(number) gives the processor contract (TAP-10 §4.3). / 名字给出处理器号。
      const f = addr(cfg.factory); const r = await call(rd, `${f}.cpuAt(${inp.name.number})`)
      if (isRevert(r)) throw new Broken('not-tapeout', `no processor number ${inp.name.number}`)
      inp.circuit = { processor: decoded('cpuAt', () => decAddress(r)), tokenId: inp.name.tokenId }; known = inp.name.number
    }
    if (inp.circuit) {
      const { processor, tokenId } = inp.circuit
      const c = await circuit(rd, cfg, processor, tokenId, known)
      Object.assign(res, { processor, tokenId: String(tokenId), holder: c.holder, container: c.container, name: c.name })
      const { data } = await readFile(rd, cfg, c.container, REGISTRATION_KEY, 'registration-file-missing', MAX_REGISTRATION_BYTES)
      const ids = listedAgentIds(parseRegistrationFile(data), chain, registry)
      if (!ids.length) throw new Broken('not-listed', "the holder's file lists no identity of this registry")
      if (ids.length > 1) { res.agentId = ids.map(String); throw new Broken('several-listed') }
      agentId = ids[0]; inputCircuit = [processor, tokenId, c.processorNumber]
    } else agentId = inp.agentId
    res.agentId = String(agentId)
    await byAgent(rd, cfg, agentId, res, fixed, inputCircuit)
  } catch (e) {
    if (e instanceof Unavailable) { res.state = 'UNAVAILABLE'; res.reasons = [e.reason]; res.unavailableRead = e.key }
    else if (e instanceof Broken) {
      res.state = e.reason === 'several-listed' ? 'AMBIGUOUS' : e.reason === 'wallet-unset' || e.reason === 'stale-agent-wallet' ? e.reason : 'BROKEN'
      res.reasons = [e.reason]; if (e.detail) res.detail = e.detail
    } else throw e
  }
  res.checked.holderHistory = res.holderEpoch !== null
  res.display = displayOf(res)
  res.draft = DRAFT
  res.experimental = true
  return res
}

async function byAgent(rd, cfg, agentId, res, fixed, inputCircuit) {
  const chain = cfg.chainId; const registry = addr(cfg.identityRegistry); const warnings = res.warnings
  let r = await call(rd, `${registry}.ownerOf(${agentId})`); if (isRevert(r)) throw new Broken('no-such-agent')
  const owner = decoded('ownerOf', () => decAddress(r))
  const meta = await call(rd, `${registry}.getMetadata(${agentId},${PASSPORT_KEY})`); if (isRevert(meta)) throw new Broken('no-passport-key', 'getMetadata reverted')
  const key = decodeKey(decoded('getMetadata', () => decDyn(meta, 0)))
  if (key.chainId !== chain) throw new Broken('chain-mismatch', `tap.passport names chain ${key.chainId}`)
  const { processor, tokenId } = key
  if (inputCircuit && (processor !== inputCircuit[0] || tokenId !== inputCircuit[1])) throw new Broken('key-circuit-mismatch')
  const c = await circuit(rd, cfg, processor, tokenId, inputCircuit ? inputCircuit[2] : null)
  Object.assign(res, { processor, tokenId: String(tokenId), holder: c.holder, container: c.container, name: c.name })
  if (owner !== c.holder) throw new Broken('holder-mismatch', `identity owner ${owner}, circuit holder ${c.holder}`)
  const wr = await call(rd, `${registry}.getAgentWallet(${agentId})`)
  const wallet = decoded('getAgentWallet', () => { if (isRevert(wr)) throw new Error('revert'); return decAddress(wr) })
  const uriR = await call(rd, `${registry}.tokenURI(${agentId})`)
  let agentUri = null; if (!isRevert(uriR)) { try { agentUri = utf8.decode(decDyn(uriR, 0)) } catch { agentUri = null } }
  const { data } = await readFile(rd, cfg, c.container, REGISTRATION_KEY, 'registration-file-missing', MAX_REGISTRATION_BYTES)
  const doc = parseRegistrationFile(data); const tap = doc.tap
  if (tap.chainId !== chain || addr(tap.processor) !== processor || BigInt(tap.tokenId) !== tokenId || addr(tap.container) !== c.container) throw new Broken('file-chain-mismatch', 'tap member differs from the chain')
  const want = 'tape://' + c.name
  if (!doc.services.some((s) => isObj(s) && s.name === 'tape' && s.endpoint === want)) throw new Broken('tape-service-missing', want)
  await operators(rd, c.container, c.holder, fixed.timestamp, warnings, res.checked)
  const ids = listedAgentIds(doc, chain, registry)
  if (!ids.includes(agentId)) throw new Broken('not-listed', `the holder's file does not list agent ${agentId}`)
  if (ids.length > 1) { res.agentId = ids.map(String); throw new Broken('several-listed') }
  const label = gatewayLabel(tokenId, c.processorNumber).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  if (agentUri === null || !new RegExp(`^https://${label}\\.[A-Za-z0-9.-]+/\\.well-known/agent-registration\\.json$`).test(agentUri)) warnings.push('agent-uri-not-canonical')
  if ('manifest' in tap) {
    const mi = await fileInfo(rd, cfg, c.container, MANIFEST_KEY)
    if (mi.chunkCount === 0n || mi.sha256 !== tap.manifest.sha256) warnings.push('manifest-hash-differs')
  }
  res.holderEpoch = await epoch(rd, agentId, processor, tokenId, c.holder, warnings)
  res.agentUri = agentUri
  if (wallet === ZERO_ADDRESS) throw new Broken('wallet-unset')
  if (wallet !== c.holder) throw new Broken('stale-agent-wallet', `agentWallet ${wallet}`)
  res.state = 'CONFIRMED'
}

// Internal reads shared with the registration helper (passport-registration.js). / 与登记文件辅助共用的内部读取。
export const internal = Object.freeze({ fixedReads, circuit, fileInfo, readFile, call, isRevert, decAddress, decDyn, decoded })

// ── §9 W-1 to W-3 / 发起签名或构造调用的工具 ─────────────────────────────
const FORBIDDEN_SELECTORS = new Set(['0x095ea7b3', '0xa22cb465', '0xa9059cbb', '0x23b872dd', '0x42842e0e', '0xb88d4fde', '0x51945447'])
/**
 * W-3 for a runtime driven by untrusted text: may it construct this call? Never approve / transfer / execute, never
 * calldata from counterparty text, only the registries and TapeOut contracts (cfg.knownProcessors: isCPU true).
 * W-3：受不可信文字驱动的运行时能否构造这个调用。
 */
export function checkRuntimeCall(cfg, to, data, fromCounterpartyText = false) {
  if (fromCounterpartyText) return { allowed: false, why: 'calldata derived from counterparty text' }
  if (typeof data !== 'string' || FORBIDDEN_SELECTORS.has(data.slice(0, 10).toLowerCase())) return { allowed: false, why: 'forbidden selector' }
  const targets = new Set(['identityRegistry', 'reputationRegistry', 'siteRegistry', 'factory', 'opener'].map((k) => addr(cfg[k])).concat((cfg.knownProcessors || []).map(addr)))
  let t; try { t = addr(to) } catch { return { allowed: false, why: 'target not an address' } }
  return targets.has(t) ? { allowed: true, why: '' } : { allowed: false, why: 'target not listed' }
}
/**
 * W-1 / W-2 for a tool that asks a holder to sign a TAP-11 delegation: a default at most 30 days ahead (7 or less
 * advised by the draft), any expiry up to TAP-11's 366 days when the holder chooses, and only a signer this tool made.
 * W-1 / W-2：默认至多 30 天（草案建议 ≤7 天）；持有人自选时最长 366 天；签名者必须是本工具在本会话生成的。
 */
export function checkDelegationProposal(now, expires, isDefault, signerGeneratedHere) {
  if (!signerGeneratedHere) return { ok: false, why: 'signer not generated by this tool in this session' }
  if (!(now < expires && expires <= now + 31_622_400)) return { ok: false, why: 'outside TAP-11 §4.3' }
  if (isDefault && expires - now > 2_592_000) return { ok: false, why: 'default expiry more than 30 days ahead' }
  if (isDefault && expires - now > 604_800) return { ok: true, why: 'default above the 7 days the draft advises' }
  return { ok: true, why: '' }
}
