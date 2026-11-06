// Property: the voucher digest the SDK signs (TAPI-22 §3.1, sig.voucherDigest) equals the escrow contract's
// voucherDigest for random vouchers. The repository has no forge ffi, and contracts/ is not changed for a test, so the
// Solidity side is reached two ways without running it: (1) the contract's source is read as text and its typehash
// string, domain name, domain version and domain type must be the strings this file hashes; (2) the digest is computed a
// second time here, independently of sdk/src: ABI words assembled by hand (32-byte left-padded addresses and integers),
// keccak256 from @noble/hashes, "\x19\x01" ‖ domainSeparator ‖ structHash, exactly as the contract's abi.encode and
// abi.encodePacked lay them out. The recorded vectors (spec/vectors/tapi-22-voucher.json, which verify.py and the forge
// tests also check) are replayed, and a signature over each random digest recovers to the signer with strict v.
// A failure prints its seed; PROP_SEED=<n> PROP_RUNS=1 node --test sdk/test/prop-voucher.test.mjs replays one iteration.
// 性质：SDK 签的凭证摘要等于托管合约的 voucherDigest（随机凭证）。仓库没有 forge ffi，也不为测试改合约，因此：(1) 把合约源码当文本读取，
// 核对类型串、域名、版本与域类型；(2) 在这里不依赖 sdk/src 再算一遍（手工拼 ABI 字、@noble/hashes 的 keccak256、0x1901 前缀）。
// 另重放已录向量，并核对每个随机摘要的签名能以严格 v 恢复出签名者。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { keccak_256 } from '@noble/hashes/sha3'
import * as sig from '../src/sig.js'
import { forAll, runsOf, seedOf } from './helpers/prng.mjs'

const SOL = readFileSync(new URL('../../contracts/src/TapeAPIEscrow.sol', import.meta.url), 'utf8')
const VEC = JSON.parse(readFileSync(new URL('../../spec/vectors/tapi-22-voucher.json', import.meta.url), 'utf8'))
const VOUCHER_TYPE = 'Voucher(address consumer,address provider,uint256 cumulative,uint64 expires)'
const DOMAIN_TYPE = 'EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'

// ---------- independent EIP-712 / 独立的 EIP-712 ----------
const te = new TextEncoder()
const k = (b) => keccak_256(b)
const hex = (b) => '0x' + Buffer.from(b).toString('hex')
const word = (n) => { if (n < 0n || n >= 1n << 256n) throw new Error('out of uint256'); return Buffer.from(n.toString(16).padStart(64, '0'), 'hex') }
const addrWord = (a) => { assert.match(a, /^0x[0-9a-fA-F]{40}$/); return Buffer.concat([Buffer.alloc(12), Buffer.from(a.slice(2), 'hex')]) }
const domainSep = (chainId, verifyingContract) => k(Buffer.concat([k(te.encode(DOMAIN_TYPE)), k(te.encode('TapeAPIEscrow')), k(te.encode('1')), word(BigInt(chainId)), addrWord(verifyingContract)]))
function digest(chainId, escrow, { consumer, provider, cumulative, expires }) {
  if (BigInt(expires) >= 1n << 64n) throw new Error('out of uint64')
  const sh = k(Buffer.concat([k(te.encode(VOUCHER_TYPE)), addrWord(consumer), addrWord(provider), word(BigInt(cumulative)), word(BigInt(expires))]))
  return k(Buffer.concat([Buffer.from([0x19, 0x01]), domainSep(chainId, escrow), sh]))
}

test('the contract source names the same type, domain name, domain version and domain type (read as text; contracts/ unchanged)', () => {
  const flat = SOL.replace(/\s+/g, ' ')
  assert.ok(flat.includes(`VOUCHER_TYPEHASH = keccak256("${VOUCHER_TYPE}")`), 'VOUCHER_TYPEHASH string')
  assert.ok(flat.includes('_NAME_HASH = keccak256("TapeAPIEscrow")'), 'domain name')
  assert.ok(flat.includes('_VERSION_HASH = keccak256("1")'), 'domain version')
  assert.ok(flat.includes(`_EIP712_DOMAIN_TYPEHASH = keccak256("${DOMAIN_TYPE}")`), 'domain type')
  assert.ok(flat.includes('abi.encode(_EIP712_DOMAIN_TYPEHASH, _NAME_HASH, _VERSION_HASH, block.chainid, address(this))'), 'domain layout')
  assert.ok(flat.includes('abi.encodePacked( "\\x19\\x01", DOMAIN_SEPARATOR(), keccak256(abi.encode(VOUCHER_TYPEHASH, consumer, provider, cumulative, expires)) )'), 'digest layout')
  assert.equal(sig.VOUCHER_TYPE, VOUCHER_TYPE)
  assert.equal(VEC.typeHash, VOUCHER_TYPE)
})

test('the recorded vectors (also checked by verify.py and forge) equal both computations', () => {
  const { chainId, verifyingContract } = VEC.domain
  for (const c of VEC.cases) {
    assert.equal(hex(digest(chainId, verifyingContract, c)), c.digest, c.name)
    assert.equal(hex(sig.voucherDigest(chainId, verifyingContract, c)), c.digest, c.name)
  }
})

test(`property (e): sig.voucherDigest equals the independent EIP-712 digest for random vouchers, and a signature recovers with strict v (${runsOf()} iterations, seed ${seedOf(0xe1)})`, async () => {
  await forAll(import.meta.url, (r) => {
    const chainId = r.pick([56, 97, 196, 8453, 1, 31337, Number(r.big(48))])
    const escrow = sig.privateKeyToAddress('0x' + r.hex(32).slice(2).padStart(64, '1'))
    const edge = r.int(6)
    const cumulative = edge === 0 ? 0n : edge === 1 ? (1n << 256n) - 1n : edge === 2 ? r.big(64) : r.big(1 + r.int(256))
    const expires = edge === 3 ? (1n << 64n) - 1n : edge === 4 ? 0n : r.big(1 + r.int(64))
    const lower = r.bool()
    const addr = () => { const a = r.hex(20); return lower ? a : sig.privateKeyToAddress('0x' + r.hex(32).slice(2)) }
    const v = { consumer: addr(), provider: addr(), cumulative: r.bool() ? cumulative : cumulative.toString(), expires: Number(expires) <= Number.MAX_SAFE_INTEGER && r.bool() ? Number(expires) : expires }
    const mine = hex(digest(chainId, escrow, v))
    assert.equal(hex(sig.voucherDigest(chainId, escrow, v)), mine, JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x)))
    // a change of any one field changes the digest / 任一字段改变则摘要改变
    const field = r.pick(['consumer', 'provider', 'cumulative', 'expires', 'chainId', 'escrow'])
    const w = { ...v }
    let cid = chainId, esc = escrow
    if (field === 'consumer' || field === 'provider') w[field] = '0x' + ((BigInt(v[field]) ^ 1n).toString(16).padStart(40, '0'))
    if (field === 'cumulative') w.cumulative = BigInt(v.cumulative) === 0n ? 1n : BigInt(v.cumulative) - 1n
    if (field === 'expires') w.expires = BigInt(v.expires) === 0n ? 1n : BigInt(v.expires) - 1n
    if (field === 'chainId') cid = chainId + 1
    if (field === 'escrow') esc = '0x' + ((BigInt(escrow) ^ (1n << 159n)).toString(16).padStart(40, '0'))
    assert.notEqual(hex(sig.voucherDigest(cid, esc, w)), mine, `${field} changed, the digest did not`)
    assert.equal(hex(digest(cid, esc, w)), hex(sig.voucherDigest(cid, esc, w)))
    // sign and recover (strict v 27/28) on a quarter of the draws: secp256k1 is the slow part / 四分之一的轮次签名并恢复
    if (r.p(0.25)) {
      const pk = '0x' + r.hex(32).slice(2).replace(/^0+/, '1').padEnd(64, '1')
      const s = sig.signDigest(sig.voucherDigest(chainId, escrow, v), pk)
      assert.equal(sig.recoverVoucherSigner(chainId, escrow, v, s), sig.privateKeyToAddress(pk))
    }
  }, { seed: seedOf(0xe1) })
})
