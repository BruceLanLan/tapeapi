// @experimental tapnet/1 policy circuits (Policy Circuit Gate TAP draft, TAPs pull request #84, not merged, §2): the file
// check, the result byte and one TAP-02 beat. Only NAND and LATCH records; a REF record is refused. Pure: no file, no
// network, no `node:` import, no Buffer; runs in a browser.
// 实验性：tapnet/1 策略电路（Policy Circuit Gate TAP 草稿，TAPs PR #84，未合并，§2）：文件检查、结果字节、TAP-02 单拍。
// 只认 NAND 与 LATCH 记录，拒绝 REF。纯函数：不读文件、不联网、不导入 node: 模块、不用 Buffer，浏览器可用。
//
// The order of the checks is the draft's (§2.2, and the reference evaluator's): the length is bounded BEFORE anything is
// parsed (a policy comes from a binder, still a tool bounds the file first), then the header, then the records, then
// TAP-02 well-formedness, then the pins. A file is identified by its netlist hash only (SHA-256 of the whole file).
// 检查顺序与草稿一致：先限长度（再解析），再查文件头、记录、TAP-02 良构、引脚。文件只按网表哈希（整个文件的 SHA-256）识别。
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex } from '@noble/hashes/utils'

/**
 * A rule of the draft was broken. `code` is the draft's problem name (for example `policy-invalid-file`,
 * `request-malformed`, `binding-malformed`), `detail` a human note.
 * 违反了草稿的某条规则。`code` 是草稿的问题名，`detail` 是说明。
 */
export class PolicyCircuitError extends Error {
  constructor(code, detail = '') {
    super(detail ? `${code}: ${detail}` : code)
    this.name = 'PolicyCircuitError'
    this.code = code
    this.detail = detail
  }
}
export const fail = (code, detail) => { throw new PolicyCircuitError(code, detail) }

/** The pin convention of the draft (§2.2, §6.1). / 草稿的引脚约定。 */
export const POLICY_CONVENTION = 'tap-policy/1'
export const POLICY_N_IN = 128
export const POLICY_N_OUT = 8
/** The most bytes a policy file may have (§2.2, the size an L1 netlist-NFT contract's storeNetlist accepts). / 文件上限。 */
export const MAX_POLICY_BYTES = 49_152
/** Reason codes 0-7 by name (§2.5); 8-63 are `reserved`, 64-127 `policy-defined`. / 原因码名称。 */
export const POLICY_REASONS = Object.freeze({
  0: 'none', 1: 'amount-over-limit', 2: 'period-limit-reached', 3: 'counterparty-not-allowed', 4: 'asset-not-allowed',
  5: 'outside-time-window', 6: 'amount-overflow', 7: 'kind-not-allowed',
})
/** The display name of a reason code (§2.5): a tool shows it and never refuses a verdict because of it. / 原因码的显示名。 */
export const policyReasonName = (r) => POLICY_REASONS[r] ?? (r >= 64 ? 'policy-defined' : 'reserved')

const MAGIC = [0x54, 0x41, 0x50, 0x4e, 0x45, 0x54]   // "TAPNET"
const MAX_SIGNALS = 1 << 24
const MAX_PINS = 1 << 16
const u32be = (b, o) => ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3]
const u24 = (b, o) => (b[o] << 16) | (b[o + 1] << 8) | b[o + 2]
const bytesOf = (data) => {
  if (!(data instanceof Uint8Array)) fail('policy-invalid-file', 'a policy file is a Uint8Array')
  return data
}

/** `0x` + SHA-256 of the whole file, lowercase (§1). / 网表哈希。 */
export function policyNetlistHash(data) { return '0x' + bytesToHex(sha256(bytesOf(data))) }

// tapnet/1 (inlined in the draft §2.1) and TAP-02 §3 well-formedness: NAND inputs name earlier signals only, a LATCH may
// name any signal (it reads the previous beat), signals fit in 2^24, pins in 2^16, and there are at least nOut elements.
// tapnet/1 与 TAP-02 §3 良构：NAND 只引用更早的信号，LATCH 可引用任何信号（读上一拍），信号数 < 2^24，引脚 ≤ 2^16，元素数 ≥ nOut。
function parseTapnet(data) {
  if (data.length < 16) fail('policy-invalid-file', 'file shorter than the 16-byte header')
  for (let i = 0; i < 6; i++) if (data[i] !== MAGIC[i]) fail('policy-invalid-file', 'bad magic')
  if (data[6] !== 1) fail('policy-invalid-file', `unsupported version ${data[6]}`)
  if (data[7] !== 0) fail('policy-invalid-file', 'reserved byte is not zero')
  const nIn = u32be(data, 8), nOut = u32be(data, 12)
  if (data.length === 16) fail('policy-invalid-file', 'no records')
  const ops = [], as = [], bs = []
  let p = 16
  while (p < data.length) {
    const op = data[p]
    if (op === 0x00) {
      if (p + 7 > data.length) fail('policy-invalid-file', `truncated record at byte ${p - 16}`)
      ops.push(0); as.push(u24(data, p + 1)); bs.push(u24(data, p + 4)); p += 7
    } else if (op === 0x01) {
      if (p + 4 > data.length) fail('policy-invalid-file', `truncated record at byte ${p - 16}`)
      ops.push(1); as.push(u24(data, p + 1)); bs.push(0); p += 4
    } else if (op === 0x02) fail('policy-invalid-file', 'REF record (opcode 0x02) is not allowed in tapnet/1')
    else fail('policy-invalid-file', `unknown opcode 0x${op.toString(16).padStart(2, '0')}`)
  }
  const n = ops.length
  const nSig = 2 + nIn + n
  if (nSig > MAX_SIGNALS) fail('policy-invalid-file', 'more than 2^24 signals')
  if (!(nIn <= MAX_PINS && nOut >= 1 && nOut <= MAX_PINS)) fail('policy-invalid-file', 'nIn/nOut out of range')
  if (n < nOut) fail('policy-invalid-file', 'too few elements for the outputs')
  const stateBase = new Int32Array(n)
  let nState = 0, nand = 0, latch = 0
  for (let k = 0; k < n; k++) {
    const first = 2 + nIn + k
    if (ops[k] === 0) {
      if (as[k] >= first || bs[k] >= first) fail('policy-invalid-file', `signal not available at element ${first}`)
      nand++
    } else {
      if (as[k] >= nSig) fail('policy-invalid-file', `signal not available at element ${first}`)
      stateBase[k] = nState++; latch++
    }
  }
  return { nIn, nOut, nand, latch, nState, ops: Uint8Array.from(ops), a: Int32Array.from(as), b: Int32Array.from(bs), stateBase }
}

/** Bit i of a packed string is bit i mod 8 of byte i div 8 (TAP-02 §5); missing bytes read 0, extra bytes are ignored. */
function unpack(bytes, n) {
  const out = new Uint8Array(n)
  for (let i = 0; i < n; i++) { const j = i >> 3; out[i] = j < bytes.length ? (bytes[j] >> (i & 7)) & 1 : 0 }
  return out
}
function pack(bits) {
  const out = new Uint8Array((bits.length + 7) >> 3)
  for (let i = 0; i < bits.length; i++) if (bits[i]) out[i >> 3] |= 1 << (i & 7)
  return out
}
// One beat (TAP-02 §4): signal 0 is 0, signal 1 is 1, then the inputs, then each element in order; a LATCH outputs the
// state it held and stores its input for the next beat. The outputs are the last nOut elements.
// 单拍：信号 0 为 0、信号 1 为 1，然后是输入、各元素；LATCH 输出所存状态并为下一拍存下输入。输出是最后 nOut 个元素。
function beat(c, stateBytes, inputBytes) {
  const st = unpack(stateBytes, c.nState), inp = unpack(inputBytes, c.nIn)
  const n = c.ops.length, base = 2 + c.nIn
  const sig = new Uint8Array(base + n)
  sig[1] = 1
  sig.set(inp, 2)
  for (let k = 0; k < n; k++) sig[base + k] = c.ops[k] === 0 ? 1 - (sig[c.a[k]] & sig[c.b[k]]) : st[c.stateBase[k]]
  const ns = new Uint8Array(c.nState)
  for (let k = 0; k < n; k++) if (c.ops[k] === 1) ns[c.stateBase[k]] = sig[c.a[k]]
  return { state: pack(ns), outputs: pack(sig.subarray(sig.length - c.nOut)) }
}

function checked(data, declaredStateful) {
  bytesOf(data)
  if (data.length > MAX_POLICY_BYTES) fail('policy-too-large', `${data.length} bytes, at most ${MAX_POLICY_BYTES}`)
  const c = parseTapnet(data)
  if (c.nIn !== POLICY_N_IN || c.nOut !== POLICY_N_OUT) fail('policy-bad-pins', `nIn ${c.nIn}, nOut ${c.nOut}`)
  const stateful = c.latch > 0
  if (declaredStateful !== null && declaredStateful !== undefined && declaredStateful !== stateful) fail('policy-stateful-mismatch', `declared ${declaredStateful}, the file has ${c.latch} LATCH records`)
  return c
}
const infoOf = (data, c) => ({
  netlistHash: policyNetlistHash(data), stateful: c.latch > 0, bytes: data.length, nand: c.nand, latch: c.latch,
  stateBytes: (c.nState + 7) >> 3, nIn: c.nIn, nOut: c.nOut,
})

/**
 * §2.2: is `data` a policy circuit? Returns its facts; throws PolicyCircuitError `policy-too-large`,
 * `policy-invalid-file`, `policy-bad-pins` or `policy-stateful-mismatch` (when `declaredStateful` is given).
 * §2.2：是不是策略电路。返回文件信息；不是则抛出草稿的问题名。
 */
export function checkPolicyCircuit(data, { declaredStateful = null } = {}) {
  return infoOf(data, checked(data, declaredStateful))
}

/**
 * Check once, keep a handle (cache it by netlistHash): its facts, `zeroState()` and `step(state, word)`, one TAP-02 beat
 * with a state of `stateBytes` bytes (empty for a combinational policy). Inputs and state are read leniently (missing
 * bytes are 0), as TAP-02 §5 does; the request word is built by policyRequestWord, never taken from a requester.
 * 检查一次、得到句柄（可按 netlistHash 缓存）：文件信息、zeroState()、step(state, word) 单拍。
 */
export function loadPolicyCircuit(data, { declaredStateful = null } = {}) {
  const c = checked(data, declaredStateful)
  const info = infoOf(data, c)
  return Object.freeze({
    ...info,
    zeroState: () => new Uint8Array(info.stateBytes),
    step(state, word) {
      if (!(state instanceof Uint8Array) || !(word instanceof Uint8Array)) fail('policy-invalid-state', 'state and word are Uint8Arrays')
      return beat(c, state, word)
    },
  })
}

/**
 * §2.3: the result byte. Exactly 0x01 is `allow`; bit 0 clear is `deny` with the reason code; bit 0 set with a reason
 * is an invalid result, a `deny` flagged `invalidResult`. Outputs shorter than one byte read as 0 (deny).
 * §2.3：只有恰为 0x01 才放行；其它一律拒绝；bit 0 置位且原因非 0 是无效结果（按拒绝，并标 invalidResult）。
 */
export function interpretPolicyOutput(outputs) {
  const b = outputs instanceof Uint8Array && outputs.length ? outputs[0] : 0
  const allow = b & 1, reason = b >> 1
  if (allow && reason === 0) return { verdict: 'allow', reason: 0 }
  if (!allow) return { verdict: 'deny', reason, reasonName: policyReasonName(reason) }
  return { verdict: 'deny', reason, reasonName: policyReasonName(reason), invalidResult: true }
}
