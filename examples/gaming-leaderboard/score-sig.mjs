// 玩家签名格式（provider 与客户端共用）/ Player signature formats, shared by provider and clients.
//   score: keccak256("TAPI-game/score/v1" ‖ player(20B) ‖ uint64BE(score) ‖ uint64BE(nonce))
//   state: keccak256("TAPI-game/state/v1" ‖ player(20B) ‖ keccak256(canonicalJSON(state)) ‖ uint64BE(nonce))
// 签名 = EIP-191 personal_sign(digest)，即钱包的 personal_sign(hexDigest) / signature = personal_sign over the 32-byte digest.
import { sig, abi, canonicalJSON } from '@tapeapi/sdk'

const { keccak256, personalDigest, signDigest, recoverAddress } = sig
const { hexToBytes, concatBytes, utf8ToBytes, toHex } = abi

function u64(n) {
  let x = BigInt(n); if (x < 0n || x >= (1n << 64n)) throw new Error('value out of uint64')
  const b = new Uint8Array(8); for (let i = 7; i >= 0; i--) { b[i] = Number(x & 0xffn); x >>= 8n } return b
}
export function scoreDigest({ player, score, nonce }) {
  return toHex(keccak256(concatBytes(utf8ToBytes('TAPI-game/score/v1'), hexToBytes(player), u64(score), u64(nonce))))
}
export function stateDigest({ player, state, nonce }) {
  return toHex(keccak256(concatBytes(utf8ToBytes('TAPI-game/state/v1'), hexToBytes(player), keccak256(utf8ToBytes(canonicalJSON(state))), u64(nonce))))
}
export const signScore = (msg, privateKey) => signDigest(personalDigest(scoreDigest(msg)), privateKey)
export const signState = (msg, privateKey) => signDigest(personalDigest(stateDigest(msg)), privateKey)
export const recoverScoreSigner = (msg, signature) => recoverAddress(personalDigest(scoreDigest(msg)), signature)
export const recoverStateSigner = (msg, signature) => recoverAddress(personalDigest(stateDigest(msg)), signature)
