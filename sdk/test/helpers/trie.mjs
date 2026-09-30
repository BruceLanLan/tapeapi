// Test-only Merkle-Patricia trie BUILDER: RLP encoding, the root of a set of keys and values, and a proof for one key.
// The SDK only verifies proofs (sdk/src/proof.js); this builds them, so tests and spec/vectors/tapi-20-proof.json can have
// proofs of tries whose roots come from the Ethereum trie tests (ethereum/tests TrieTests), including embedded nodes.
// 仅供测试的默克尔-帕特里夏树**构建器**：RLP 编码、一组键值的根、某个键的证明。SDK 只核验证明；这里构建证明，使测试与向量文件能用
// 根值来自以太坊 trie 测试（ethereum/tests TrieTests）的树的证明，包括内嵌节点。
import { keccak_256 } from '@noble/hashes/sha3'
import { bytesToHex, hexToBytes, utf8ToBytes, concatBytes } from '@noble/hashes/utils'

const lenBytes = (n) => { const out = []; while (n > 0) { out.unshift(n & 0xff); n = Math.floor(n / 256) } return Uint8Array.from(out) }
/** RLP-encode bytes or a (nested) array of items / RLP 编码 */
export function rlpEncode(item) {
  if (item instanceof Uint8Array) {
    if (item.length === 1 && item[0] < 0x80) return item
    if (item.length < 56) return concatBytes(Uint8Array.of(0x80 + item.length), item)
    const l = lenBytes(item.length)
    return concatBytes(Uint8Array.of(0xb7 + l.length), l, item)
  }
  const body = concatBytes(...item.map(rlpEncode))
  if (body.length < 56) return concatBytes(Uint8Array.of(0xc0 + body.length), body)
  const l = lenBytes(body.length)
  return concatBytes(Uint8Array.of(0xf7 + l.length), l, body)
}
const nibbles = (b) => [...b].flatMap((x) => [x >> 4, x & 15])
function hexPrefix(path, leaf) {
  const flag = (leaf ? 2 : 0) + (path.length % 2)
  const all = path.length % 2 ? [flag, ...path] : [flag, 0, ...path]
  const out = new Uint8Array(all.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = (all[2 * i] << 4) | all[2 * i + 1]
  return out
}
const EMPTY = new Uint8Array(0)

function build(items, depth) {
  if (items.length === 0) return null
  if (items.length === 1) return { leaf: true, path: items[0].path.slice(depth), value: items[0].value }
  let cp = 0
  for (;;) {
    const x = items[0].path[depth + cp]
    if (x === undefined || !items.every((it) => it.path[depth + cp] === x)) break
    cp++
  }
  if (cp > 0) return { ext: true, path: items[0].path.slice(depth, depth + cp), child: build(items, depth + cp) }
  const kids = Array.from({ length: 16 }, (_, n) => build(items.filter((it) => it.path[depth] === n), depth + 1))
  const here = items.find((it) => it.path.length === depth)
  return { branch: true, kids, value: here ? here.value : EMPTY }
}
function itemOf(n) {
  if (n.leaf) return [hexPrefix(n.path, true), n.value]
  if (n.ext) return [hexPrefix(n.path, false), refOf(n.child)]
  return [...n.kids.map((k) => (k ? refOf(k) : EMPTY)), n.value]
}
// A node under 32 bytes is embedded in its parent; otherwise the parent holds its hash / 不足 32 字节的节点内嵌，否则引用其哈希
function refOf(n) { const item = itemOf(n); const enc = rlpEncode(item); return enc.length < 32 ? item : keccak_256(enc) }

/**
 * A trie over `pairs` ([keyBytes, valueBytes]; `secure` hashes each key first): { root, proof(key) }. proof(key) lists the
 * hash-referenced nodes from the root down to where the key is or would be, as eth_getProof does (hex strings).
 * 由 `pairs` 构建的树：root 与 proof(key)。proof 与 eth_getProof 相同，列出从根往下经由哈希引用的节点（十六进制）。
 */
export function buildTrie(pairs, { secure = false } = {}) {
  const keyOf = (k) => (secure ? keccak_256(k) : k)
  const items = pairs.filter(([, v]) => v.length > 0).map(([k, v]) => ({ path: nibbles(keyOf(k)), value: v }))
  const rootNode = build(items, 0)
  const root = '0x' + bytesToHex(keccak_256(rlpEncode(rootNode ? itemOf(rootNode) : EMPTY)))
  function proof(key) {
    if (!rootNode) return []
    const path = nibbles(keyOf(key))
    const out = []
    let n = rootNode, pi = 0, first = true
    while (n) {
      const enc = rlpEncode(itemOf(n))
      if (first || enc.length >= 32) out.push('0x' + bytesToHex(enc))
      first = false
      if (n.leaf) break
      if (n.ext) {
        const seg = path.slice(pi, pi + n.path.length)
        if (seg.length < n.path.length || seg.some((x, i) => x !== n.path[i])) break
        pi += n.path.length; n = n.child; continue
      }
      if (pi === path.length) break
      n = n.kids[path[pi++]]
    }
    return out
  }
  return { root, proof }
}
/** A trie-test key or value: 0x-hex, or else UTF-8 text / trie 测试的键或值：0x 十六进制，否则 UTF-8 文本 */
export const trieBytes = (s) => (typeof s === 'string' && s.startsWith('0x') ? hexToBytes(s.slice(2)) : utf8ToBytes(String(s ?? '')))
