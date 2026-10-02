// @experimental security 1.2: Merkle proofs of chain state (EIP-1186 eth_getProof), checked here against a stateRoot.
// Outside the 1.0 stability promise; it may change in a 1.x minor release.
// @experimental 安全加固 1.2：链上状态的默克尔证明（EIP-1186 eth_getProof），在本地对照 stateRoot 核验。不在 1.0 稳定承诺之内。
//
// What a proof adds (TAPI-20 §3.2, informative): the value of a storage slot no longer rests on the nodes that answer
// eth_call agreeing, only on the block's stateRoot, which nodes of `quorum` independent operators confirmed (the pinned
// block, rpc.confirmedBlock). The proof itself may come from any node: a wrong one fails here. What it does not add: an
// upgrade of a TapeOut contract is real state, and every proof agrees with it; operators that all collude on the block
// header defeat it; and a slot is only meaningful under the storage layout of the code that reads it (STORAGE below).
// 证明带来的（TAPI-20 §3.2，说明性）：存储槽的值不再依赖作答节点的 eth_call 一致，只依赖区块的 stateRoot，而它由 quorum 家独立
// 运营方确认（钉住的区块）。证明本身可以来自任何节点：错的证明在这里核验不过。它带不来的：TapeOut 合约升级是真实状态，所有证明都
// 会与之一致；所有运营方在区块头上合谋就能绕过它；一个槽只有在读取它的代码的存储布局下才有意义（见下面的 STORAGE）。
//
// Leaf module apart from @noble/hashes and errors.js. / 除 @noble/hashes 与 errors.js 外不导入任何东西。
import { keccak_256 } from '@noble/hashes/sha3'
import { bytesToHex, utf8ToBytes, concatBytes } from '@noble/hashes/utils'
import { TapeAPIError } from './errors.js'

const bad = (msg) => new TapeAPIError('PROOF_INVALID', msg)
const hex = (b) => '0x' + bytesToHex(b)
const eqBytes = (a, b) => a.length === b.length && a.every((x, i) => x === b[i])
/** keccak256 of the empty string: the code hash of an account without code / 空串的 keccak256：无代码账户的 codeHash */
export const EMPTY_CODE_HASH = '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470'
/** keccak256(rlp('')): the root of an empty trie / 空树的根 */
export const EMPTY_TRIE_ROOT = '0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421'

// Strict hex: 0x, an even number of digits. / 严格的十六进制：带 0x、偶数位。
function bytesOf(h, what) {
  if (typeof h !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(h)) throw bad(`${what} is not 0x-prefixed hex bytes`)
  const out = new Uint8Array((h.length - 2) / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(2 + 2 * i, 4 + 2 * i), 16)
  return out
}
const word = (v) => { const b = new Uint8Array(32); let n = BigInt(v); for (let i = 31; i >= 0; i--) { b[i] = Number(n & 0xffn); n >>= 8n } return b }
const bigOf = (b) => b.reduce((n, x) => (n << 8n) | BigInt(x), 0n)

// ---------------------------------------------------------------- RLP ----
// Canonical encodings only: a single byte below 0x80 is never wrapped, a length never has leading zeros, the long form is
// never used for fewer than 56 bytes, and nothing follows the item. A list is an Array with `rlpLength`, the length of
// its own encoding (a trie node shorter than 32 bytes is embedded in its parent instead of hashed).
// 只接受规范编码：小于 0x80 的单字节不得再包装，长度不得有前导零，不足 56 字节不得用长格式，项之后不得有尾随字节。列表是带
// `rlpLength`（自身编码长度）的数组：短于 32 字节的树节点嵌在父节点里而不是按哈希引用。
// Lists nest at most RLP_MAX_DEPTH deep (FIXED PROOFR-3: the decoder recursed without a bound, and ~20k nested lists threw
// a bare RangeError from the public API). The bound is far above anything a trie node holds: a node is referenced by hash
// once its encoding reaches 32 bytes, so a list embedded in a node is under 32 bytes, and each level of nesting costs at
// least one byte of header, which leaves at most 31 levels inside a node, 32 with the node itself; the account leaf is
// decoded on its own (one level). / 列表嵌套至多 RLP_MAX_DEPTH 层（FIXED PROOFR-3：原先递归无上限，约 2 万层嵌套会从公开 API
// 抛出裸 RangeError）。该上限远高于任何树节点：编码达到 32 字节的节点按哈希引用，所以节点里内嵌的列表不足 32 字节，而每层嵌套
// 至少占一个字节的头，节点内部至多 31 层，连同节点本身 32 层；账户叶子单独解码（一层）。
export const RLP_MAX_DEPTH = 64
// The public functions throw PROOF_INVALID and nothing else, whatever they are given (FIXED PROOFR-3).
// 公开函数不论收到什么，都只抛 PROOF_INVALID（FIXED PROOFR-3）。
const guarded = (name, fn) => Object.defineProperty(function (...args) {
  try { return fn.apply(this, args) } catch (e) {
    if (e instanceof TapeAPIError && e.code === 'PROOF_INVALID') throw e
    throw new TapeAPIError('PROOF_INVALID', `malformed proof input: ${String(e?.message ?? e).slice(0, 120)}`, { cause: e })
  }
}, 'name', { value: name })
/** @experimental Decode one canonical RLP item: a Uint8Array, or an Array of items. / 解码一个规范 RLP 项。 */
export const rlpDecode = guarded('rlpDecode', (bytes) => {
  if (!(bytes instanceof Uint8Array)) throw bad('rlp input must be bytes')
  const [item, end] = rlpItem(bytes, 0, bytes.length, 0)
  if (end !== bytes.length) throw bad('rlp: trailing bytes after the item')
  return item
})
function rlpLen(b, at, n, limit) {
  if (n === 0 || at + n > limit) throw bad('rlp: length runs past the input')
  if (b[at] === 0) throw bad('rlp: length with a leading zero')
  let len = 0
  for (let i = 0; i < n; i++) len = len * 256 + b[at + i]
  if (len < 56) throw bad('rlp: long form for fewer than 56 bytes')
  if (!Number.isSafeInteger(len)) throw bad('rlp: length too large')
  return len
}
function rlpItem(b, at, limit, depth) {
  if (at >= limit) throw bad('rlp: input ended early')
  const p = b[at]
  if (p < 0x80) return [b.subarray(at, at + 1), at + 1]
  if (p <= 0xbf) {
    let start, len
    if (p <= 0xb7) { start = at + 1; len = p - 0x80 } else { const n = p - 0xb7; len = rlpLen(b, at + 1, n, limit); start = at + 1 + n }
    if (start + len > limit) throw bad('rlp: string runs past the input')
    if (len === 1 && b[start] < 0x80) throw bad('rlp: single byte below 0x80 must not be wrapped')
    return [b.subarray(start, start + len), start + len]
  }
  let start, len
  if (p <= 0xf7) { start = at + 1; len = p - 0xc0 } else { const n = p - 0xf7; len = rlpLen(b, at + 1, n, limit); start = at + 1 + n }
  const end = start + len
  if (end > limit) throw bad('rlp: list runs past the input')
  if (depth >= RLP_MAX_DEPTH) throw bad(`rlp: lists nested more than ${RLP_MAX_DEPTH} deep`)
  const out = []
  let i = start
  while (i < end) { const [x, next] = rlpItem(b, i, end, depth + 1); out.push(x); i = next }
  Object.defineProperty(out, 'rlpLength', { value: end - at })
  return [out, end]
}

// ---------------------------------------------------------------- Merkle-Patricia trie ----
const nibblesOf = (b) => { const out = new Array(b.length * 2); b.forEach((x, i) => { out[2 * i] = x >> 4; out[2 * i + 1] = x & 15 }); return out }
// Hex-prefix encoding (Yellow Paper appendix C): flag 0/1 extension, 2/3 leaf; odd length puts the first nibble beside
// the flag, even length pads with a zero nibble. / Hex-prefix 编码：标志 0/1 为扩展，2/3 为叶子；偶数长度须以零半字节填充。
function hexPrefix(b) {
  if (!(b instanceof Uint8Array) || b.length === 0) throw bad('trie: node path is empty')
  const flag = b[0] >> 4
  if (flag > 3) throw bad('trie: bad hex-prefix flag')
  const odd = flag & 1
  if (!odd && (b[0] & 15) !== 0) throw bad('trie: even hex-prefix with a non-zero pad nibble')
  const all = nibblesOf(b)
  return { leaf: flag >= 2, path: all.slice(odd ? 1 : 2) }
}

/**
 * @experimental Verify a Merkle-Patricia proof: the value stored under `key` in the trie whose root hash is `root`, or
 * null when the proof shows the key is absent. `proof` is the list of RLP nodes from the root down, as eth_getProof gives
 * it (hex strings or bytes). `secure: true` is Ethereum's state and storage tries, whose keys are keccak256 hashes (the
 * caller passes the hash); there no value sits in a branch. Throws PROOF_INVALID on anything else, including nodes the
 * walk did not use.
 * @experimental 核验默克尔-帕特里夏树证明：返回根为 `root` 的树中 `key` 下的值；证明表明键不存在时返回 null。`proof` 为从根往下的
 * RLP 节点列表（与 eth_getProof 相同）。`secure: true` 为以太坊的状态树与存储树（键为 keccak256，调用方传入哈希），其分支节点不带值。
 * 其它任何情况（包括没有用到的节点）都抛 PROOF_INVALID。
 */
export const verifyMptProof = guarded('verifyMptProof', (root, key, proof, opts) => {
  if (opts !== undefined && (opts === null || typeof opts !== 'object')) throw bad('trie: options must be an object')
  const secure = opts?.secure ?? false
  if (typeof secure !== 'boolean') throw bad('trie: secure must be a boolean')
  const rootB = typeof root === 'string' ? bytesOf(root, 'root') : root
  if (!(rootB instanceof Uint8Array) || rootB.length !== 32) throw bad('trie: root must be 32 bytes')
  const keyB = typeof key === 'string' ? bytesOf(key, 'key') : key
  if (!(keyB instanceof Uint8Array)) throw bad('trie: key must be hex or bytes')
  if (secure && keyB.length !== 32) throw bad('trie: a secure-trie key is 32 bytes')
  if (!Array.isArray(proof)) throw bad('trie: proof must be a list of nodes')
  const nodes = proof.map((n, i) => {
    if (typeof n === 'string') return bytesOf(n, `proof node ${i}`)
    if (n instanceof Uint8Array) return n
    throw bad(`trie: proof node ${i} is neither hex nor bytes`)
  })
  // An empty trie: no node, or the one node rlp('') / 空树：没有节点，或唯一的节点 rlp('')
  if (hex(rootB) === EMPTY_TRIE_ROOT) {
    if (nodes.length === 0 || (nodes.length === 1 && nodes[0].length === 1 && nodes[0][0] === 0x80)) return null
    throw bad('trie: nodes given for an empty trie')
  }
  const path = nibblesOf(keyB)
  let pi = 0, used = 0, want = rootB, embedded = null
  const follow = (ref, where) => {
    if (Array.isArray(ref)) {
      if (ref.rlpLength >= 32) throw bad(`trie: an embedded node of ${ref.rlpLength} bytes (${where}); only nodes under 32 bytes are embedded`)
      embedded = ref
    } else if (ref instanceof Uint8Array && ref.length === 32) want = ref
    else throw bad(`trie: a child reference that is neither a hash nor an embedded node (${where})`)
  }
  const done = (value) => {
    if (used !== nodes.length) throw bad(`trie: ${nodes.length - used} proof node(s) left unused`)
    return value
  }
  for (;;) {
    let node
    if (embedded) { node = embedded; embedded = null }
    else {
      if (used >= nodes.length) throw bad('trie: the proof ends before the key does')
      const raw = nodes[used]
      if (!eqBytes(keccak_256(raw), want)) throw bad(`trie: proof node ${used} does not hash to its reference`)
      node = rlpDecode(raw)
      used++
      if (!Array.isArray(node)) throw bad(`trie: proof node ${used - 1} is not a list`)
    }
    if (node.length === 17) {
      for (let i = 0; i < 16; i++) {
        const c = node[i]
        if (!(Array.isArray(c) || (c instanceof Uint8Array && (c.length === 0 || c.length === 32)))) throw bad('trie: a branch child that is neither empty, a hash nor an embedded node')
      }
      if (!(node[16] instanceof Uint8Array)) throw bad('trie: a branch value that is a list')
      if (pi === path.length) {
        if (secure) throw bad('trie: a secure-trie key ends at a branch')
        return done(node[16].length ? node[16] : null)
      }
      if (secure && node[16].length) throw bad('trie: a branch with a value in a secure trie')
      const ref = node[path[pi]]
      pi++
      if (ref instanceof Uint8Array && ref.length === 0) return done(null)
      follow(ref, `branch nibble ${path[pi - 1]}`)
    } else if (node.length === 2) {
      const { leaf, path: seg } = hexPrefix(node[0])
      const here = path.slice(pi, pi + seg.length)
      if (leaf) {
        if (!(node[1] instanceof Uint8Array) || node[1].length === 0) throw bad('trie: a leaf without a value')
        if (pi + seg.length === path.length && here.every((x, i) => x === seg[i])) return done(node[1])
        if (secure && pi + seg.length !== path.length) throw bad('trie: a secure-trie leaf whose key has the wrong length')
        return done(null)
      }
      if (seg.length === 0) throw bad('trie: an extension with an empty path')
      if (here.length < seg.length || !here.every((x, i) => x === seg[i])) return done(null)
      pi += seg.length
      follow(node[1], 'extension')
    } else throw bad(`trie: a node with ${node.length} items`)
  }
})

// ---------------------------------------------------------------- EIP-1186 ----
/** @experimental keccak256 of bytes, a string (UTF-8) or 0x-hex (bytes) / keccak256 */
const k256 = (...parts) => keccak_256(concatBytes(...parts))

/**
 * @experimental Check one eth_getProof answer against `stateRoot`: the account of `address` (null fields for an account
 * that does not exist) and the value of every slot in `slots` (bigint; 0 when absent). Every slot asked for must be
 * answered, and the answer's own storageHash, keys and values must equal what the proof shows. Throws PROOF_INVALID.
 * @experimental 对照 `stateRoot` 核验一个 eth_getProof 回答：`address` 的账户（不存在的账户各字段为 null）与 `slots` 中每个槽的值
 * （bigint，不存在为 0）。每个请求的槽都必须有回答，回答自带的 storageHash、key、value 必须与证明一致。否则抛 PROOF_INVALID。
 */
export const verifyAccountProof = guarded('verifyAccountProof', (stateRoot, address, slots, answer) => {
  if (!answer || typeof answer !== 'object') throw bad('eth_getProof: no answer object')
  if (!Array.isArray(slots)) throw bad('slots must be a list')
  const addr = bytesOf(address, 'address')
  if (addr.length !== 20) throw bad('address must be 20 bytes')
  if (typeof answer.address === 'string' && answer.address.toLowerCase() !== address.toLowerCase()) throw bad(`eth_getProof answered for ${answer.address.slice(0, 42)}, not ${address}`)
  const leaf = verifyMptProof(stateRoot, keccak_256(addr), answer.accountProof, { secure: true })
  let account
  if (leaf === null) account = { exists: false, nonce: 0n, balance: 0n, storageRoot: EMPTY_TRIE_ROOT, codeHash: EMPTY_CODE_HASH }
  else {
    const acc = rlpDecode(leaf)
    if (!Array.isArray(acc) || acc.length !== 4 || acc.some((x) => !(x instanceof Uint8Array))) throw bad('account leaf is not [nonce, balance, storageRoot, codeHash]')
    if (acc[2].length !== 32 || acc[3].length !== 32) throw bad('account storageRoot or codeHash is not 32 bytes')
    for (const n of [acc[0], acc[1]]) if (n.length && n[0] === 0) throw bad('account nonce or balance with a leading zero')
    account = { exists: true, nonce: bigOf(acc[0]), balance: bigOf(acc[1]), storageRoot: hex(acc[2]), codeHash: hex(acc[3]) }
  }
  if (answer.storageHash !== undefined && account.exists && String(answer.storageHash).toLowerCase() !== account.storageRoot) throw bad('eth_getProof: storageHash differs from the proven storage root')
  if (!Array.isArray(answer.storageProof)) throw bad('eth_getProof: no storageProof list')
  const values = new Map()
  for (const s of slots) {
    const slot = BigInt(s)
    const entries = answer.storageProof.filter((e) => { try { return e && BigInt(e.key) === slot } catch { return false } })
    if (entries.length !== 1) throw bad(`eth_getProof: slot 0x${slot.toString(16)} answered ${entries.length} times`)
    const e = entries[0]
    const v = verifyMptProof(account.storageRoot, keccak_256(word(slot)), e.proof, { secure: true })
    let value = 0n
    if (v !== null) {
      const inner = rlpDecode(v)
      if (!(inner instanceof Uint8Array) || inner.length === 0 || inner.length > 32 || inner[0] === 0) throw bad(`storage value of slot 0x${slot.toString(16)} is not a canonical non-zero word`)
      value = bigOf(inner)
    }
    let claimed
    try { claimed = BigInt(e.value) } catch { throw bad(`eth_getProof: slot 0x${slot.toString(16)} has a value that is not a number`) }
    if (claimed !== value) throw bad(`eth_getProof: slot 0x${slot.toString(16)} claims 0x${claimed.toString(16)}, the proof shows 0x${value.toString(16)}`)
    values.set(slot, value)
  }
  return { account, values }
})

// ---------------------------------------------------------------- storage layouts ----
// Where TapeOut keeps what resolve reads, measured 2026-09-30 (eth_createAccessList, then eth_getStorageAt against the
// eth_call answers: BSC 11.1013.tape and 4246.0.tape, X Layer 1.2.230.tape). A layout belongs to the CODE: it is used only
// when the proven ERC-1967 implementation of the proxy is one listed here (chains.js expectedImpl), and the circuits
// contracts (beacon proxies, no cheap proof of their code) are cross-checked against eth_call instead.
// TapeOut 存放 resolve 所读数据的位置，2026-09-30 实测（先 eth_createAccessList，再用 eth_getStorageAt 与 eth_call 的回答比对：BSC 的
// 11.1013.tape 与 4246.0.tape，X Layer 的 1.2.230.tape）。布局属于**代码**：只有证明出的代理实现在下表中时才套用；电路合约（beacon
// 代理，没有便宜的代码证明）改为与 eth_call 交叉比对。
// - SiteRegistry: mapping(address => Site) at slot 1; Site.files, mapping(bytes32 keccak(path) => File), at Site + 2; File:
//   +0 chunkCount, +1 size (low 32 bits) and updatedAt (from bit 32), +2 sha256Hash, +3 contentType (a string).
//   SiteRegistry：槽 1 为 mapping(address => Site)；Site 偏移 2 为 files（键 keccak(path)）；File：+0 分块数，+1 低 32 位 size、
//   第 32 位起 updatedAt，+2 sha256Hash，+3 contentType。
// - Processor factory: address[] of processors at slot 6 (cpuAt), mapping(address => bool) isCPU at slot 7.
//   处理器工厂：槽 6 为处理器数组（cpuAt），槽 7 为 isCPU 映射。
// - Circuits (OpenZeppelin ERC721Upgradeable, ERC-7201 namespace "openzeppelin.storage.ERC721"): _owners at base + 2.
//   电路合约（OpenZeppelin ERC721Upgradeable，ERC-7201 命名空间）：_owners 在基址 + 2。
export const LAYOUT_IMPLEMENTATIONS = Object.freeze({
  siteRegistry: Object.freeze(['0x1d279d138a4d803378a7d4557c056f1bed53c261', '0xa85c4143d1d4a77f54b8e4ecc9e6d1418afea45f']),
  factory: Object.freeze(['0xa68ccf4931d98ad0a4be15ee40542edc0dec6422', '0x74956236ab64ed143933040b4137e8a352e4d17b']),
})
const ERC721_NAMESPACE = 0x80bb2b638cc20bc4d0a60d66940f3ab4a00c1d7b313497ca82fb0b4ab0079300n
const M256 = 1n << 256n
const slotHash = (...parts) => bigOf(k256(...parts))
/** @experimental Storage slots of the reads resolve makes (see the layouts above). / resolve 所读数据的存储槽。 */
export const STORAGE = Object.freeze({
  /** SiteRegistry fileInfo(container, key): the slots of `size` (low 32 bits) and `sha256Hash` */
  fileInfo(container, key) {
    const site = slotHash(word(BigInt(container)), word(1n))
    const base = slotHash(k256(utf8ToBytes(key)), word((site + 2n) % M256))
    return { size: (base + 1n) % M256, sha256Hash: (base + 2n) % M256 }
  },
  /** circuits ownerOf(tokenId) / 电路合约 ownerOf */
  ownerOf: (tokenId) => slotHash(word(BigInt(tokenId)), word(ERC721_NAMESPACE + 2n)),
  /** factory cpuAt(n): the array length and element n / 工厂 cpuAt(n)：数组长度与第 n 个元素 */
  cpuAt: (n) => ({ length: 6n, element: (slotHash(word(6n)) + BigInt(n)) % M256 }),
  /** factory isCPU(circuits) / 工厂 isCPU */
  isCPU: (circuits) => slotHash(word(BigInt(circuits)), word(7n)),
})
/**
 * @experimental The address a word holds (lower case), or null when its high 12 bytes are not zero: a word that is not a
 * zero-padded address is not an address (FIXED PROOFR-4: the ERC-1967 slot was read by its low 20 bytes only, while cpuAt
 * and ownerOf already required the high bytes to be zero).
 * @experimental 字中的地址（小写）；高 12 字节不为零时返回 null：不是零填充地址的字就不是地址（FIXED PROOFR-4：ERC-1967 槽原先只看
 * 低 20 字节，而 cpuAt 与 ownerOf 已要求高字节为零）。
 */
export const addressOfWord = (v) => {
  const n = BigInt(v)
  if (n < 0n || n >> 160n !== 0n) return null
  return '0x' + n.toString(16).padStart(40, '0')
}
