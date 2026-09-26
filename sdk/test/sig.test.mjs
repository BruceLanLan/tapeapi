import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bytesToHex } from '@noble/hashes/utils'
import { secp256k1 } from '@noble/curves/secp256k1'
import { TapeAPIError } from '../src/errors.js'
import {
  keccak256, personalDigest, signDigest, recoverAddress, privateKeyToAddress, domainSeparator, typedDigest,
  hashDelegation, hashVoucher, delegationDigest, voucherDigest, responseDigest, signResponse, recoverResponseSigner,
  DELEGATION_TYPEHASH, VOUCHER_TYPEHASH, RESPONSE_DIGEST_PREFIX,
} from '../src/sig.js'
import { canonicalJSON } from '../src/canon.js'

const PK1 = '0x' + '1'.padStart(64, '0')
const PK2 = '0x' + '2'.padStart(64, '0')

test('keccak256 known vectors', () => {
  assert.equal(bytesToHex(keccak256('')), 'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470')
  assert.equal(bytesToHex(keccak256('0x')), 'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470')
  // ERC-20 Transfer topic / 经典事件 topic
  assert.equal(bytesToHex(keccak256('Transfer(address,address,uint256)')), 'ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef')
})
test('privateKeyToAddress known vectors', () => {
  assert.equal(privateKeyToAddress(PK1), '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf')
  assert.equal(privateKeyToAddress(PK2), '0x2B5AD5c4795c026514f8317c7a215E218DcCD6cF')
})
test('EIP-712 domain separator matches the EIP-712 reference example', () => {
  const ds = domainSeparator({ name: 'Ether Mail', version: '1', chainId: 1, verifyingContract: '0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC' })
  assert.equal(bytesToHex(ds), 'f2cee375fa42b42143804025fc449deafd50cc031ca257e0b194a650a912090f')
})
test('type hashes are keccak of the exact type strings', () => {
  assert.equal(bytesToHex(DELEGATION_TYPEHASH), bytesToHex(keccak256('Delegation(address container,address signer,uint64 expires)')))
  assert.equal(bytesToHex(VOUCHER_TYPEHASH), bytesToHex(keccak256('Voucher(address consumer,address provider,uint256 cumulative,uint64 expires)')))
})
test('EIP-191 personal digest = keccak(prefix ‖ len ‖ msg)', () => {
  const d = keccak256('hello')
  const manual = keccak256(new Uint8Array([...new TextEncoder().encode('\x19Ethereum Signed Message:\n32'), ...d]))
  assert.equal(bytesToHex(personalDigest(d)), bytesToHex(manual))
})
test('signDigest yields 65-byte sig with v in {27,28}; recover round-trips; deterministic (RFC6979)', () => {
  const d = keccak256('tapeapi')
  const s1 = signDigest(d, PK1), s2 = signDigest(d, PK1)
  assert.equal(s1.length, 132); assert.equal(s1, s2)
  const v = parseInt(s1.slice(-2), 16); assert.ok(v === 27 || v === 28)
  assert.equal(recoverAddress(d, s1), privateKeyToAddress(PK1))
  assert.notEqual(recoverAddress(d, signDigest(d, PK2)), privateKeyToAddress(PK1))
  // 篡改摘要则恢复出别的地址 / tampered digest recovers a different address
  assert.notEqual(recoverAddress(keccak256('tapeapi!'), s1), privateKeyToAddress(PK1))
})
test('Delegation / Voucher struct hashing and typed digest are deterministic', () => {
  const dir = '0x' + '30'.repeat(20), esc = '0x' + '40'.repeat(20)
  const del = { container: '0x' + '60'.repeat(20), signer: privateKeyToAddress(PK2), expires: 1790000000 }
  const h = hashDelegation(del)
  const manualDigest = typedDigest({ name: 'TapeAPI', version: '1', chainId: 56, verifyingContract: dir }, h)
  assert.equal(bytesToHex(delegationDigest(56, dir, del)), bytesToHex(manualDigest))
  const sig = signDigest(delegationDigest(56, dir, del), PK1)
  assert.equal(recoverAddress(delegationDigest(56, dir, del), sig), privateKeyToAddress(PK1))
  // 不同 chainId 的委托无效 / a different chainId gives a different digest
  assert.notEqual(bytesToHex(delegationDigest(97, dir, del)), bytesToHex(delegationDigest(56, dir, del)))
  const vch = { consumer: privateKeyToAddress(PK1), provider: del.container, cumulative: 10n ** 14n, expires: 1758400000 }
  assert.equal(bytesToHex(hashVoucher(vch)), bytesToHex(hashVoucher({ ...vch, cumulative: '100000000000000' })))
  assert.equal(recoverAddress(voucherDigest(56, esc, vch), signDigest(voucherDigest(56, esc, vch), PK2)), privateKeyToAddress(PK2))
})
// 把合法签名改成高 s 形式（s → n − s，v 翻转）/ malleate a valid signature into its high-s twin.
export function malleate(sigHex) {
  const n = secp256k1.CURVE.n
  const r = sigHex.slice(2, 66), s = BigInt('0x' + sigHex.slice(66, 130)), v = parseInt(sigHex.slice(130), 16)
  const s2 = (n - s).toString(16).padStart(64, '0')
  return '0x' + r + s2 + (v === 27 ? 28 : 27).toString(16)
}
test('C-02: recoverAddress rejects high-s (malleated) signatures and bad v, like the contract', () => {
  const d = keccak256('voucher')
  const good = signDigest(d, PK1)
  assert.equal(recoverAddress(d, good), privateKeyToAddress(PK1))
  const bad = malleate(good)
  // noble alone would recover the same address from the malleated twin; our wrapper must refuse it
  assert.throws(() => recoverAddress(d, bad), (e) => e instanceof TapeAPIError && e.code === 'BAD_SIGNATURE' && /high-s/.test(e.message))
  // v ∈ {0,1} is normalised, anything else rejected / v 0/1 归一化，其余拒绝
  assert.equal(recoverAddress(d, good.slice(0, 130) + (parseInt(good.slice(130), 16) - 27).toString(16).padStart(2, '0')), privateKeyToAddress(PK1))
  for (const v of ['1d', '00ff', '29']) assert.throws(() => recoverAddress(d, good.slice(0, 130) + v.slice(-2)), (e) => e.code === 'BAD_SIGNATURE')
  assert.throws(() => recoverAddress(d, '0x' + '00'.repeat(65)), (e) => e.code === 'BAD_SIGNATURE')
})
test('responseDigest follows the TAP-21 v2 layout: request hash + ok byte + canonical body', () => {
  const container = '0x' + '11'.repeat(20)
  const env = { container, id: 'req-1', method: 'read', params: { chainId: 1, b: 2 }, ok: true, body: { b: 1, a: [1, 2] }, ts: 1758300000 }
  const enc = new TextEncoder()
  const ts = new Uint8Array(8); new DataView(ts.buffer).setBigUint64(0, 1758300000n)
  assert.equal(RESPONSE_DIGEST_PREFIX, 'TAPI-1/resp/v2')
  const manual = keccak256(new Uint8Array([
    ...enc.encode('TAPI-1/resp/v2'), ...Buffer.from('11'.repeat(20), 'hex'), ...keccak256('req-1'),
    ...keccak256(enc.encode(canonicalJSON({ method: 'read', params: { b: 2, chainId: 1 } }))), 1,
    ...keccak256(enc.encode(canonicalJSON({ a: [1, 2], b: 1 }))), ...ts,
  ]))
  assert.equal(bytesToHex(responseDigest(env)), bytesToHex(manual))
  // informative constant published in TAP-21 §6 / 规范 §6 的参考常量
  assert.equal(bytesToHex(keccak256('TAPI-1/resp/v2')), 'bd61d43697493b5514339aa5ca816a32e8911486b4b1e5395614878bd164011d')
  assert.equal(bytesToHex(responseDigest(env)), bytesToHex(responseDigest({ ...env, body: { a: [1, 2], b: 1 }, params: { b: 2, chainId: 1 } })))
  assert.notEqual(bytesToHex(responseDigest(env)), bytesToHex(responseDigest({ ...env, ts: 1758300001 })))
  // M-07: ok flag, method and params are all covered / ok、method、params 都在签名范围内
  assert.notEqual(bytesToHex(responseDigest(env)), bytesToHex(responseDigest({ ...env, ok: false })))
  assert.notEqual(bytesToHex(responseDigest(env)), bytesToHex(responseDigest({ ...env, method: 'write' })))
  assert.notEqual(bytesToHex(responseDigest(env)), bytesToHex(responseDigest({ ...env, params: { chainId: 2, b: 2 } })))
  // params omitted ≡ {} / 缺省 params 等价于 {}
  assert.equal(bytesToHex(responseDigest({ ...env, params: undefined })), bytesToHex(responseDigest({ ...env, params: {} })))
  const sig = signResponse(env, PK1)
  assert.equal(recoverResponseSigner(env, sig), privateKeyToAddress(PK1))
  assert.notEqual(recoverResponseSigner({ ...env, id: 'req-2' }, sig), privateKeyToAddress(PK1))
  assert.notEqual(recoverResponseSigner({ ...env, ok: false }, sig), privateKeyToAddress(PK1))
  for (const missing of [{ ...env, ok: undefined }, { ...env, method: undefined }]) assert.throws(() => responseDigest(missing), (e) => e.code === 'ABI_INVALID')
})
