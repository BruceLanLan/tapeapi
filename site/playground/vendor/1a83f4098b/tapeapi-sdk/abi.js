import { keccak_256 } from '@noble/hashes/sha3'
import { bytesToHex, hexToBytes as nobleHexToBytes, concatBytes, utf8ToBytes } from '@noble/hashes/utils'
import { TapeAPIError } from './errors.js'

// ---------- hex 工具 / hex helpers ----------
export function strip0x(h) { return h.startsWith('0x') || h.startsWith('0X') ? h.slice(2) : h }
export function hexToBytes(h) {
  if (typeof h !== 'string') throw new TapeAPIError('ABI_INVALID', 'hex must be string')
  let s = strip0x(h)
  if (s.length % 2) s = '0' + s
  if (!/^[0-9a-fA-F]*$/.test(s)) throw new TapeAPIError('ABI_INVALID', 'bad hex')
  return nobleHexToBytes(s)
}
export function toHex(bytes) { return '0x' + bytesToHex(bytes) }
export { bytesToHex, concatBytes, utf8ToBytes }

export function keccak256(data) {
  const b = typeof data === 'string' ? (data.startsWith('0x') ? hexToBytes(data) : utf8ToBytes(data)) : data
  return keccak_256(b)
}

// ---------- 地址 / addresses ----------
export function isAddress(a) { return typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a) }
export function checksumAddress(a) {
  if (!isAddress(a)) throw new TapeAPIError('ABI_INVALID', `bad address ${a}`)
  const low = strip0x(a).toLowerCase()
  const h = bytesToHex(keccak_256(utf8ToBytes(low)))
  let out = '0x'
  for (let i = 0; i < 40; i++) out += parseInt(h[i], 16) >= 8 ? low[i].toUpperCase() : low[i]
  return out
}
export function eqAddr(a, b) { return typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase() }
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

// ---------- bytes32 label ----------
// 可打印 ASCII 右填充 bytes32；拒绝非 ASCII（同形字钓鱼，L-21）与控制字符 / Printable-ASCII label right-padded to
// bytes32. Non-ASCII (homoglyph phishing, review L-21), spaces and control characters are rejected.
export const LABEL_RE = /^[\x21-\x7e]{1,32}$/
export function labelToBytes32(label) {
  if (typeof label === 'string' && /^0x[0-9a-fA-F]{64}$/.test(label)) return label.toLowerCase()
  if (typeof label !== 'string' || !LABEL_RE.test(label)) throw new TapeAPIError('ABI_INVALID', 'label must be 1..32 printable ASCII characters (no spaces, no control or non-ASCII characters)')
  const b = utf8ToBytes(label)
  const out = new Uint8Array(32); out.set(b)
  return toHex(out)
}
export function bytes32ToLabel(h) {
  const b = hexToBytes(h); let n = b.length
  while (n > 0 && b[n - 1] === 0) n--
  return new TextDecoder().decode(b.subarray(0, n))
}

// ---------- 编码 / encoding ----------
const UINT_RE = /^uint(\d+)$/
// {name,type} 描述符归一为纯类型 / Normalise {name,type} descriptors to bare types.
function norm(t) { return (typeof t === 'object' && t !== null && t.type !== 'tuple') ? t.type : t }
function isTuple(t) { return typeof t === 'object' && t !== null && t.type === 'tuple' }
function isDynamic(t) {
  t = norm(t)
  if (isTuple(t)) return t.components.some(isDynamic)
  return t === 'string' || t === 'bytes'
}
function headLen(t) {
  t = norm(t)
  if (isDynamic(t)) return 32
  if (isTuple(t)) return t.components.reduce((n, c) => n + headLen(c), 0)
  return 32
}
function toBig(v, t) {
  if (typeof v === 'bigint') return v
  if (typeof v === 'number') { if (!Number.isSafeInteger(v)) throw new TapeAPIError('ABI_INVALID', `unsafe number for ${t}`); return BigInt(v) }
  if (typeof v === 'string' && /^(0x[0-9a-fA-F]+|\d+)$/.test(v)) return BigInt(v)
  if (typeof v === 'boolean') return v ? 1n : 0n
  throw new TapeAPIError('ABI_INVALID', `cannot convert ${String(v)} to ${t}`)
}
function padUint(v, bits) {
  if (v < 0n || v >= (1n << BigInt(bits))) throw new TapeAPIError('ABI_INVALID', `uint${bits} out of range`)
  return hexToBytes(v.toString(16).padStart(64, '0'))
}
function padRight(b) {
  const out = new Uint8Array(Math.ceil(b.length / 32) * 32); out.set(b); return out
}
function encodeOne(t, v) {
  t = norm(t)
  if (isTuple(t)) {
    const vals = Array.isArray(v) ? v : t.components.map(c => v[c.name])
    return encodeParams(t.components, vals)
  }
  if (t === 'address') { if (!isAddress(v)) throw new TapeAPIError('ABI_INVALID', `bad address ${v}`); return hexToBytes(strip0x(v).toLowerCase().padStart(64, '0')) }
  if (t === 'bool') return padUint(toBig(v, t), 8)
  const m = UINT_RE.exec(t)
  if (m) return padUint(toBig(v, t), Number(m[1]))
  if (t === 'bytes32') { const b = typeof v === 'string' ? hexToBytes(v) : v; if (b.length !== 32) throw new TapeAPIError('ABI_INVALID', 'bytes32 length'); return b }
  if (t === 'bytes') { const b = typeof v === 'string' ? hexToBytes(v) : v; return concatBytes(padUint(BigInt(b.length), 256), padRight(b)) }
  if (t === 'string') { const b = utf8ToBytes(v); return concatBytes(padUint(BigInt(b.length), 256), padRight(b)) }
  throw new TapeAPIError('ABI_INVALID', `unsupported type ${JSON.stringify(t)}`)
}
export function encodeParams(types, values) {
  if (types.length !== values.length) throw new TapeAPIError('ABI_INVALID', 'arity mismatch')
  const heads = [], tails = []
  let offset = types.reduce((n, t) => n + headLen(t), 0)
  types.forEach((t, i) => {
    if (isDynamic(t)) {
      const enc = encodeOne(t, values[i])
      heads.push(padUint(BigInt(offset), 256)); tails.push(enc); offset += enc.length
    } else heads.push(encodeOne(t, values[i]))
  })
  return concatBytes(...heads, ...tails)
}

// ---------- 解码 / decoding ----------
function readWord(data, pos) {
  if (pos + 32 > data.length) throw new TapeAPIError('ABI_INVALID', 'abi data too short')
  return data.subarray(pos, pos + 32)
}
function readUint(data, pos) { return BigInt('0x' + bytesToHex(readWord(data, pos))) }
function decodeOne(t, data, pos) {
  t = norm(t)
  if (isTuple(t)) return decodeParams(t.components, data, pos)
  if (t === 'address') return checksumAddress('0x' + bytesToHex(readWord(data, pos).subarray(12)))
  if (t === 'bool') return readUint(data, pos) !== 0n
  if (UINT_RE.test(t)) return readUint(data, pos)
  if (t === 'bytes32') return toHex(readWord(data, pos))
  if (t === 'bytes' || t === 'string') {
    const len = Number(readUint(data, pos))
    if (pos + 32 + len > data.length) throw new TapeAPIError('ABI_INVALID', 'dynamic data out of bounds')
    const b = data.subarray(pos + 32, pos + 32 + len)
    return t === 'bytes' ? toHex(b) : new TextDecoder().decode(b)
  }
  throw new TapeAPIError('ABI_INVALID', `unsupported type ${JSON.stringify(t)}`)
}
// 返回数组；若 types 带 name 则同时挂命名属性 / Array result, plus named props when types carry names.
export function decodeParams(types, data, base = 0) {
  const bytes = typeof data === 'string' ? hexToBytes(data) : data
  const out = []
  let pos = base
  for (const t of types) {
    const ty = norm(t)
    if (isDynamic(ty)) { out.push(decodeOne(ty, bytes, base + Number(readUint(bytes, pos)))); pos += 32 }
    else { out.push(decodeOne(ty, bytes, pos)); pos += headLen(ty) }
  }
  types.forEach((t, i) => { if (t && typeof t === 'object' && t.name) out[t.name] = out[i] })
  return out
}

// ---------- 函数表 / function table ----------
function typeSig(t) { t = norm(t); return isTuple(t) ? '(' + t.components.map(typeSig).join(',') + ')' : t }
export const SERVICE_TUPLE = {
  type: 'tuple',
  components: [
    { name: 'circuits', type: 'address' }, { name: 'tokenId', type: 'uint256' }, { name: 'container', type: 'address' },
    { name: 'label', type: 'bytes32' }, { name: 'manifestPath', type: 'string' }, { name: 'updatedAt', type: 'uint256' },
  ],
}
export const FUNCTIONS = {
  // DeWebHub
  accountOf: { inputs: ['address', 'uint256'], outputs: ['address'] },
  // TapeOut processor factory: is this ERC-721 a real TapeOut processor? / 处理器工厂：这个 ERC-721 是真的 TapeOut 处理器吗
  isCPU: { inputs: ['address'], outputs: ['bool'] },
  // cpuAt(i): processor contract number i, so a name <#ID>.<i>.tape resolves (TapeKit SPEC §3.2); reverts past the end.
  // cpuAt(i)：第 i 号处理器合约，名字 <#ID>.<i>.tape 由此解析；超出范围时 revert。
  cpuAt: { inputs: ['uint256'], outputs: ['address'] },
  // TAP-10 §4.2 step 1: how many processors the factory has (a number >= cpuCount is no-such-cpu) / 工厂已有多少个处理器
  cpuCount: { inputs: [], outputs: ['uint256'] },
  // Container opener (TAP-10 §4.2 steps 3 and 5, Appendix A): accountOf has the hub's selector, so a read is told apart by
  // its address only; isOpened says whether the circuit's container was opened (its one-time fee paid).
  // 容器开通器：accountOf 与 hub 的选择器相同，只能按地址区分；isOpened 表示该电路的容器是否已开通。
  isOpened: { inputs: ['address', 'uint256'], outputs: ['bool'] },
  // TAP-10 key lookup (TAPI-26 §3.1). keyFor returns a struct of static members only, so it is ABI-encoded inline
  // exactly like ten separate return values. ERC-6551 token() maps a container back to (chainId, circuits, tokenId).
  // TAP-10 密钥查询。keyFor 返回的结构体只含静态成员，ABI 编码与十个独立返回值相同。token() 把容器映射回电路。
  keyFor: { inputs: ['address', 'uint256'], outputs: ['address', 'bytes32', 'bool', 'address', 'uint8', 'uint16', 'bytes32', 'bool', 'uint32', 'uint64'] },
  token: { inputs: [], outputs: ['uint256', 'address', 'uint256'] },
  // SiteRegistry (TAPI-20 §3.2). fileInfo has a dynamic `string` in a multi-value return, so its outputs are
  // decoded as a top-level head/tail list, not a tuple; named descriptors expose .size/.sha256Hash on the result.
  // fileInfo 的返回值含动态 string（多值返回，非 tuple），按顶层 head/tail 解码；命名描述符让结果带 .size/.sha256Hash。
  read: { inputs: ['address', 'string'], outputs: ['bytes'] },
  // SiteRegistry writes (TapeKit SPEC Appendix B.5). Selectors verified against the mainnet implementation
  // 0x1d279d138a4d803378a7d4557c056f1bed53c261 on 2026-09-21 (putFile fab2ed82, appendChunk e2b51347,
  // removeFile 0a9c1871, setFallback 4dc21ad0). `onlyEditor`: the holder or an operator set with setOperator.
  // SiteRegistry 写接口（TapeKit SPEC 附录 B.5），选择器已对主网实现逐一核对。只有持有者或 setOperator 授权的操作员可调用。
  putFile: { inputs: ['address', 'string', 'string', 'bytes32', 'bytes'], outputs: [] },   // (container, path, contentType, sha256, firstChunk ≤ 24000 B)
  appendChunk: { inputs: ['address', 'string', 'uint256', 'bytes'], outputs: [] },          // (container, path, expectIndex, chunk)
  removeFile: { inputs: ['address', 'string'], outputs: [] },
  setFallback: { inputs: ['address', 'string'], outputs: [] },
  setOperator: { inputs: ['address', 'address', 'uint256'], outputs: [] },                  // (container, op, ttlSeconds)
  pathCount: { inputs: ['address'], outputs: ['uint256'] },
  isOpenedContainer: { inputs: ['address'], outputs: ['bool'] },
  fileInfo: {
    inputs: ['address', 'string'],
    outputs: [
      { name: 'size', type: 'uint256' }, { name: 'contentType', type: 'string' }, { name: 'sha256Hash', type: 'bytes32' },
      { name: 'updatedAt', type: 'uint256' }, { name: 'chunkCount', type: 'uint256' },
    ],
  },
  // DomainBinding, read-only (TAP-10 §6.3, Appendix A): is this name activated for this container? `isContainerLive` reverts on
  // implementations that lack it, and a client treats a revert as false. DomainBinding 只读：名字是否已激活（TAP-10 §6.3）；
  // 不支持 isContainerLive 的实现会 revert，客户端按 false 处理。
  isLive: { inputs: ['string', 'address'], outputs: ['bool'] },             // (on-chain name, container)
  isContainerLive: { inputs: ['address'], outputs: ['bool'] },
  containerPaidUntil: { inputs: ['address'], outputs: ['uint40'] },
  monthlyFee: { inputs: [], outputs: ['uint256'] },                         // wei per 30 days; read at payment time, never hard-coded
  // IERC721 / IERC20
  ownerOf: { inputs: ['uint256'], outputs: ['address'] },
  balanceOf: { inputs: ['address'], outputs: ['uint256'] },
  // ServiceDirectory
  resolve: { inputs: ['bytes32'], outputs: ['address'] },
  serviceOf: { inputs: ['address'], outputs: [SERVICE_TUPLE] },
  register: { inputs: ['address', 'uint256', 'bytes32', 'string'], outputs: [] },
  // TapeAPIEscrow v2: one channel per (consumer, provider); the channel balance is the cap (TAPI-22 §3.3,
  // TAPI-22 §3.3). No allowance, no revoke: `fund` only adds, `authorizeSession` only extends, and
  // the single consumer-side delay is requestWithdraw -> 48h -> withdraw (7d window).
  // 托管 v2：每个 (消费者, 提供者) 一条通道，通道余额即上限。没有额度、没有撤销；唯一的消费者侧延迟是提现。
  fund: { inputs: ['address', 'uint256'], outputs: [] },                    // (provider, amount)
  requestWithdraw: { inputs: ['address', 'uint256'], outputs: [] },         // (provider, amount)
  cancelWithdraw: { inputs: ['address'], outputs: [] },                     // (provider)
  withdraw: { inputs: ['address'], outputs: [] },                           // (provider)
  authorizeSession: { inputs: ['address', 'address', 'uint64'], outputs: [] }, // (provider, key, expires), expires <= now + 30d
  settle: { inputs: ['address', 'address', 'uint256', 'uint64', 'bytes'], outputs: [] },
  channelOf: { inputs: ['address', 'address'], outputs: ['uint256'] },      // (consumer, provider)
  claimedOf: { inputs: ['address', 'address'], outputs: ['uint256'] },
  sessionExpiry: { inputs: ['address', 'address', 'address'], outputs: ['uint64'] }, // (consumer, provider, key)
  pendingWithdraw: { inputs: ['address', 'address'], outputs: ['uint256', 'uint64'] }, // (consumer, provider) -> (amount, requestedAt)
  WITHDRAW_COOLDOWN: { inputs: [], outputs: ['uint64'] },
  WITHDRAW_WINDOW: { inputs: [], outputs: ['uint64'] },
  MAX_SESSION: { inputs: [], outputs: ['uint64'] },
  acceptOwnership: { inputs: [], outputs: [] },
  // v0.2 contribution model (zero protocol fee) / v0.2 贡献模型（零协议费）
  contributionOf: { inputs: ['address'], outputs: ['uint16'] },
  setContribution: { inputs: ['address', 'uint256', 'uint16'], outputs: [] },
  treasury: { inputs: [], outputs: ['address'] },
  // BEM (ERC-20): the escrow moves tokens with transferFrom, so a consumer approves it first / 消费者先授权托管合约
  approve: { inputs: ['address', 'uint256'], outputs: ['bool'] },
  // ChannelBus (TAPI-26 §3.7): the chain as a relay. `event Wire(bytes32 indexed room, bytes wire)`
  // ChannelBus：把链当作中继。sendMany 的 bytes 为若干 `uint16 长度 ‖ 消息` / packed = uint16 length ‖ wire, repeated
  send: { inputs: ['bytes32', 'bytes'], outputs: [] },
  sendMany: { inputs: ['bytes32', 'bytes'], outputs: [] },
}
export function signatureOf(name) {
  const f = FUNCTIONS[name]; if (!f) throw new TapeAPIError('ABI_INVALID', `unknown function ${name}`)
  return `${name}(${f.inputs.map(typeSig).join(',')})`
}
export function selector(nameOrSig) {
  const sig = FUNCTIONS[nameOrSig] ? signatureOf(nameOrSig) : nameOrSig
  return toHex(keccak_256(utf8ToBytes(sig)).subarray(0, 4))
}
export function encodeCall(name, args = []) {
  const f = FUNCTIONS[name]; if (!f) throw new TapeAPIError('ABI_INVALID', `unknown function ${name}`)
  return selector(name) + bytesToHex(encodeParams(f.inputs, args))
}
export function decodeCall(name, data) {
  const f = FUNCTIONS[name]; if (!f) throw new TapeAPIError('ABI_INVALID', `unknown function ${name}`)
  const bytes = hexToBytes(data)
  if (toHex(bytes.subarray(0, 4)) !== selector(name)) throw new TapeAPIError('ABI_INVALID', 'selector mismatch')
  return decodeParams(f.inputs, bytes.subarray(4))
}
export function decodeReturn(name, data) {
  const f = FUNCTIONS[name]; if (!f) throw new TapeAPIError('ABI_INVALID', `unknown function ${name}`)
  const out = decodeParams(f.outputs, data)
  return f.outputs.length === 1 ? out[0] : out
}
export function encodeReturn(name, values) {
  const f = FUNCTIONS[name]
  return toHex(encodeParams(f.outputs, Array.isArray(values) ? values : [values]))
}
// 按 selector 反查函数名 / Reverse lookup by selector (used by fake RPCs / tooling).
export function functionBySelector(data) {
  const sel = data.slice(0, 10).toLowerCase()
  for (const name of Object.keys(FUNCTIONS)) if (selector(name) === sel) return name
  return null
}
