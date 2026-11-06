// @experimental Tables, requests and the 128-bit request word (Policy Circuit Gate TAP draft §3), one-request evaluation
// and trace replay (§4.1, §4.2). Pure; runs in a browser.
// 实验性：表、请求与 128 位请求字（草稿 §3），单请求求值与轨迹重放（§4.1、§4.2）。纯函数，浏览器可用。
//
// Big integers (amounts up to 2^256, ts up to 2^64): every integer member takes a decimal string, a bigint or a JS
// number that is a SAFE integer. An unsafe JS number (above 2^53 - 1) has already lost its value, so it is refused as
// malformed, never rounded; across JSON, send amounts and anything above 2^53 as decimal strings (as TAP-11 §6 does).
// 大整数：每个整数成员接受十进制字符串、bigint 或"安全整数"的 JS 数字。不安全的 JS 数字（超过 2^53 - 1）已经丢了精度，
// 按格式错误拒绝，绝不四舍五入；经 JSON 传输时金额以及任何超过 2^53 的值都用十进制字符串（与 TAP-11 §6 一致）。
import { keccak_256 } from '@noble/hashes/sha3'
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils'
import { canonicalJSON } from '@tapeapi/sdk/canon'
import { fail, PolicyCircuitError, POLICY_N_IN, interpretPolicyOutput } from './tapnet.js'

const ADDR = /^0x[0-9a-f]{40}$/
const DEC = /^(0|[1-9][0-9]*)$/
const TWO_256 = 1n << 256n
const TWO_64 = 1n << 64n
const TWO_32 = 1n << 32n
export const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
export const sameKeys = (o, ks) => isObj(o) && Object.keys(o).length === ks.length && ks.every((k) => Object.hasOwn(o, k))
export const hex = (b) => '0x' + bytesToHex(b)
export const fromHex = (s) => hexToBytes(s.slice(2))

/** A non-negative integer as a bigint, from a decimal string, a bigint or a safe JS integer; anything else is `code`. */
export function decOf(v, where, code = 'request-malformed') {
  if (typeof v === 'number') {
    if (!Number.isSafeInteger(v)) fail(code, `${where}: a JS number must be a safe integer (send larger values as decimal strings)`)
    if (v < 0) fail(code, `${where}: negative`)
    return BigInt(v)
  }
  if (typeof v === 'bigint') { if (v < 0n) fail(code, `${where}: negative`); return v }
  if (typeof v !== 'string' || !DEC.test(v)) fail(code, `${where}: expected a non-negative decimal integer or string`)
  return BigInt(v)
}
const addrOf = (v, where) => { if (typeof v !== 'string' || !ADDR.test(v)) fail('request-malformed', `${where}: expected 0x + 40 lowercase hex digits`); return v }

// ---- §3.1 tables / 表 ----
/** Request kinds (§3.4); 5-7 are reserved and a policy should deny them. / 请求种类。 */
export const POLICY_KINDS = Object.freeze({ 0: 'other', 1: 'pay', 2: 'fund', 3: 'call', 4: 'transfer' })

/**
 * §3.1: check the tables of a binding: exactly `assets` (lowercase address -> `{ class: 1-255, unit }`, the unit a decimal
 * string without sign or leading zero in [1, 2^256)) and `counterparties` (lowercase address -> class 1-255). Returns them
 * normalised (Maps; the unit a bigint); `tables-malformed` otherwise, including the single `amountUnit` member of earlier
 * versions of the draft. / §3.1：检查绑定的表。每种资产自带类别与单位；旧版草稿的单一 amountUnit 即 tables-malformed。
 */
export function checkPolicyTables(t) {
  if (!sameKeys(t, ['assets', 'counterparties'])) fail('tables-malformed', 'members must be exactly assets, counterparties')
  const out = { assets: new Map(), counterparties: new Map() }
  for (const name of ['assets', 'counterparties']) {
    if (!isObj(t[name])) fail('tables-malformed', `${name} must be an object`)
    for (const [k, c] of Object.entries(t[name])) {
      if (!ADDR.test(k)) fail('tables-malformed', `${name}: key ${JSON.stringify(k)} is not a lowercase address`)
      if (name === 'counterparties') { out[name].set(k, classOf(c, `${name}[${k}]`)); continue }
      if (!sameKeys(c, ['class', 'unit'])) fail('tables-malformed', `assets[${k}]: an entry has exactly class and unit`)
      out.assets.set(k, { class: classOf(c.class, `assets[${k}]`), unit: unitOf(c.unit, `assets[${k}]`) })
    }
  }
  return out
}
const classOf = (c, where) => { if (!Number.isInteger(c) || c < 1 || c > 255) fail('tables-malformed', `${where}: class must be an integer in [1, 255]`); return c }
// a unit is JSON (its hash is over canonicalJSON): a decimal string only, so one value has one form; never a number or a bigint
// 单位是 JSON（哈希按规范 JSON 算）：只收十进制字符串，一个值只有一种写法；不收数字与 bigint
const unitOf = (u, where) => {
  if (typeof u !== 'string' || !DEC.test(u)) fail('tables-malformed', `${where}: unit must be a decimal string without sign or leading zero`)
  const n = BigInt(u)
  if (n < 1n || n >= TWO_256) fail('tables-malformed', `${where}: unit must be in [1, 2^256)`)
  return n
}
/** `0x` + keccak256(utf8(canonicalJSON(tables))) over the tables as written (§3.1, TAP-11 §6). / 表哈希。 */
export function policyTablesHash(t) {
  checkPolicyTables(t)
  let text
  try { text = canonicalJSON(t) } catch (e) { fail('tables-malformed', `canonical JSON: ${e.message}`) }
  return hex(keccak_256(utf8ToBytes(text)))
}

// ---- §3.2 requests / 请求 ----
/**
 * §3.2: check a request: exactly `amount` ([0, 2^256), base units of `asset`), `asset`, `counterparty` (lowercase
 * addresses), `kind` (0-7) and `ts` ([0, 2^64), the gatekeeper's time). Returns it normalised (bigint amount and ts);
 * `request-malformed` otherwise. / §3.2：检查请求，返回规范化结果；不合格即 request-malformed。
 */
export function checkPolicyRequest(r) {
  if (!sameKeys(r, ['amount', 'asset', 'counterparty', 'kind', 'ts'])) fail('request-malformed', 'members must be exactly amount, asset, counterparty, kind, ts')
  const amount = decOf(r.amount, 'amount')
  if (amount >= TWO_256) fail('request-malformed', 'amount must be below 2^256')
  if (!Number.isInteger(r.kind) || r.kind < 0 || r.kind > 7) fail('request-malformed', 'kind must be an integer in [0, 7]')
  const ts = decOf(r.ts, 'ts')
  if (ts >= TWO_64) fail('request-malformed', 'ts must be below 2^64')
  return { amount, asset: addrOf(r.asset, 'asset'), counterparty: addrOf(r.counterparty, 'counterparty'), kind: r.kind, ts }
}

// ---- §3.3 the request word / 请求字 ----
const LAYOUT = [['amount', 0, 32], ['overflow', 32, 1], ['asset', 40, 8], ['counterparty', 48, 8], ['kind', 56, 3], ['day', 64, 16], ['hour', 80, 5], ['weekday', 85, 3]]
const RESERVED = [[33, 40], [59, 64], [88, 128]]

/**
 * §3.3: the fields of the request word before packing. The amount is counted in the unit of the request's own asset,
 * rounds UP to whole units and saturates at 2^32 - 1 with `overflow` set; an asset the tables do not list has no unit:
 * overflow 1, amount 2^32 - 1, asset 0, whatever its amount (zero included). An unlisted counterparty is class 0;
 * day = floor(ts / 86400) mod 65536, hour in UTC, weekday with Monday 0.
 * 请求字各字段：金额按该资产自己的单位向上取整、饱和并置溢出位；表里没有的资产没有单位：溢出位 1、金额 2^32-1、资产 0（金额为 0 也一样）；
 * 未列出的对手方为 0 类；日、时（UTC）、星期（周一为 0）。
 */
export function policyRequestFields(request, tables) {
  const r = checkPolicyRequest(request), t = checkPolicyTables(tables)
  const a = t.assets.get(r.asset)
  const units = a === undefined ? TWO_32 : (r.amount + a.unit - 1n) / a.unit
  const overflow = units >= TWO_32
  const day = r.ts / 86400n
  return {
    amount: overflow ? 0xffffffff : Number(units), overflow: overflow ? 1 : 0,
    asset: a?.class ?? 0, counterparty: t.counterparties.get(r.counterparty) ?? 0, kind: r.kind,
    day: Number(day % 65536n), hour: Number((r.ts / 3600n) % 24n), weekday: Number((day + 3n) % 7n),
  }
}
const wordOf = (f) => LAYOUT.reduce((w, [k, lo]) => w | (BigInt(f[k]) << BigInt(lo)), 0n)
const le16 = (w) => { const b = new Uint8Array(POLICY_N_IN / 8); for (let i = 0; i < b.length; i++) b[i] = Number((w >> BigInt(8 * i)) & 0xffn); return b }

/**
 * §3.3: the 16-byte request word (bit i of the word is input i, packed as TAP-02 §5). A verifier rebuilds it from the
 * request and the tables and never trusts a word it was handed. / 16 字节请求字；核验方自己从请求与表重算，绝不信任收到的字。
 */
export function policyRequestWord(request, tables) { return le16(wordOf(policyRequestFields(request, tables))) }

/**
 * The fields of a 16-byte word, for display only: `word-malformed` for another length, `word-reserved-bits` when a
 * reserved bit is set. / 只用于显示：长度不对或保留位非 0 即拒绝。
 */
export function decodePolicyWord(word) {
  if (!(word instanceof Uint8Array) || word.length !== POLICY_N_IN / 8) fail('word-malformed', `${word?.length} bytes`)
  let w = 0n
  for (let i = word.length - 1; i >= 0; i--) w = (w << 8n) | BigInt(word[i])
  const bits = (lo, n) => (w >> BigInt(lo)) & ((1n << BigInt(n)) - 1n)
  const f = Object.fromEntries(LAYOUT.map(([k, lo, n]) => [k, Number(bits(lo, n))]))
  for (const [lo, hi] of RESERVED) if (bits(lo, hi - lo) !== 0n) fail('word-reserved-bits', `bits ${lo}..${hi - 1} are not zero`)
  return f
}

// ---- §4.1 one request / 单个请求 ----
const stateBytesOf = (circuit, state) => {
  if (state === null || state === undefined) return circuit.zeroState()
  if (state instanceof Uint8Array) return state
  if (typeof state === 'string' && /^0x(?:[0-9a-f]{2})*$/i.test(state)) return fromHex(state.toLowerCase())
  fail('policy-invalid-state', 'state is a Uint8Array or 0x-hex')
}
const isCircuit = (c) => c && typeof c.step === 'function' && typeof c.zeroState === 'function' && typeof c.stateful === 'boolean'
const needCircuit = (c) => { if (!isCircuit(c)) fail('policy-invalid-file', 'expected a handle from loadPolicyCircuit'); return c }

/**
 * §4.1: one request. The word is built here from `request` and `tables`; a combinational policy runs one beat with no
 * state, a stateful one runs one beat with `state` (zero when absent) and returns `newState`. `word`, `outputs` and
 * `newState` are 0x-hex. / §4.1：单个请求。组合策略无状态跑一拍；有状态策略用给定状态跑一拍并返回 newState。
 */
export function evaluatePolicyRequest(circuit, request, tables, state = null) {
  needCircuit(circuit)
  const word = policyRequestWord(request, tables)
  if (circuit.stateful) {
    const { state: ns, outputs } = circuit.step(stateBytesOf(circuit, state), word)
    return { word: hex(word), ...interpretPolicyOutput(outputs), outputs: hex(outputs), newState: hex(ns) }
  }
  const { outputs } = circuit.step(new Uint8Array(0), word)
  return { word: hex(word), ...interpretPolicyOutput(outputs), outputs: hex(outputs) }
}
/** `evalFile` semantics (§4.3): combinational policies only; a stateful one is `policy-stateful`. / 只用于组合策略。 */
export function evalPolicyFile(circuit, request, tables) {
  needCircuit(circuit)
  if (circuit.stateful) fail('policy-stateful', 'evalFile is not defined for a netlist with LATCH records')
  return evaluatePolicyRequest(circuit, request, tables)
}

// ---- §4.2 traces / 轨迹 ----
/**
 * §4.2: replay one gatekeeper's trace from the all-zero state, request by request (a denied request still takes its
 * beat). Entries are `{ request, verdict? }`, or with `escrowCumulative` `{ request (no amount), cumulative, verdict? }`:
 * the amount is then the increase over the last ALLOWED cumulative (0 before any). `ts` must not decrease and must lie in
 * [notBefore, expires] when given; a recorded verdict that differs is `trace-mismatch`. Throws on the first bad entry.
 * §4.2：从全零状态逐条重放一个守门方的轨迹（被拒的请求也走一拍）。托管模式下金额是相对上一个"已放行"累计值的差额。
 */
export function replayPolicyTrace(circuit, tables, entries, { notBefore = null, expires = null, escrowCumulative = false } = {}) {
  needCircuit(circuit)
  if (!Array.isArray(entries)) fail('trace-malformed', 'entries is an array')
  const nb = notBefore === null || notBefore === undefined ? null : decOf(notBefore, 'notBefore', 'trace-malformed')
  const ex = expires === null || expires === undefined ? null : decOf(expires, 'expires', 'trace-malformed')
  let state = circuit.zeroState(), lastTs = -1n, lastCum = 0n
  const results = []
  entries.forEach((e, i) => {
    if (!isObj(e) || !isObj(e.request)) fail('trace-malformed', `entry ${i}`)
    const req = { ...e.request }
    let cum = null
    if (escrowCumulative) {
      if ('amount' in req || !('cumulative' in e)) fail('trace-malformed', `entry ${i}: escrow entries carry cumulative, not amount`)
      cum = decOf(e.cumulative, `entry ${i}: cumulative`, 'trace-malformed')
      if (cum < lastCum) fail('trace-cumulative-decreases', `entry ${i}`)
      req.amount = (cum - lastCum).toString()
    }
    const r = checkPolicyRequest(req)
    if (r.ts < lastTs) fail('trace-not-monotone', `entry ${i}: ts ${r.ts} < ${lastTs}`)
    if (nb !== null && r.ts < nb) fail('trace-before-binding', `entry ${i}`)
    if (ex !== null && r.ts > ex) fail('trace-after-binding', `entry ${i}`)
    const res = evaluatePolicyRequest(circuit, req, tables, circuit.stateful ? state : null)
    if (circuit.stateful) state = fromHex(res.newState)
    if ('verdict' in e && e.verdict !== res.verdict) fail('trace-mismatch', `entry ${i}: recorded ${e.verdict}, computed ${res.verdict}`)
    if (escrowCumulative) { res.amount = req.amount; if (res.verdict === 'allow') lastCum = cum }
    lastTs = r.ts
    results.push(res)
  })
  return { results, finalState: circuit.stateful ? hex(state) : null, allowed: results.filter((r) => r.verdict === 'allow').length }
}

export { PolicyCircuitError }
