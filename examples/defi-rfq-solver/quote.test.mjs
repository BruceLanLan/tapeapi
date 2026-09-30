// `quote.mjs` 的单测：不联网、不开套接字。测的是 TAPI-24 §3.3 的 typehash / digest / 签名语义，
// 定价的截断方向，以及错误码。金值（digest、65 字节签名）由固定 `(key, quote, domain)` 生成：
// noble 的 RFC6979 确定性 nonce 保证同样的输入永远给同样的签名。
//
// Unit tests for `quote.mjs`: no network, no socket. They cover the typehash / digest / signature semantics of
// TAPI-24 §3.3, the truncation direction of the pricing, and the error codes. The golden values (digest, 65-byte
// signature) come from a fixed `(key, quote, domain)`: noble's RFC6979 deterministic nonce makes the signature
// reproducible.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { sig, abi } from '@tapeapi/sdk'
import {
  selfCheck, QUOTE_TYPE_STRING, QUOTE_TYPEHASH, ESCROW_NAME, ESCROW_NAME_HASH, QUOTE_FIELDS,
  quoteDomain, quoteStructHash, quoteDigest, signQuote, verifyQuote,
  priceAmountOut, validateConfig, validateQuoteParams, buildQuote, findPair,
  createQuoteBook, quoteStatus, STATUS_NOTE, TTL_DEFAULT,
} from './quote.mjs'

const config = validateConfig(JSON.parse(await readFile(new URL('quote.config.json', import.meta.url), 'utf8')))

// ---------- 固定向量 / fixed vectors ----------
const KEY = '0x' + '11'.repeat(32)                       // 测试私钥，仅此文件使用 / a test-only private key
const SOLVER = '0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A'
const ZERO = '0x0000000000000000000000000000000000000000'
const QUOTE = {
  quoteId: '0x' + 'ab'.repeat(32),
  fromChain: 56,
  fromToken: '0x55d398326f99059fF775485246999027B3197955',
  amountIn: '1000000000000000000000',
  toChain: 8453,
  toToken: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  amountOut: '997000000',
  recipient: '0x000000000000000000000000000000000000dEaD',
  expires: 1789999999,
  solver: SOLVER,
}
const DOMAIN = quoteDomain(56, ZERO)
const GOLDEN = {
  structHash: '0x60dd9106bd38590b522ec578eeb8f0b3b86cd15bec2a2a6f836dcffa241720d8',
  digest: '0xe48415dd5a25f41aa9891ecb4d2364975b6fcef8b9f2905213b314db1f104b66',
  sig: '0x9e4c7500236b63c3e233b2785cea21b68ce91a29bc4a54b0b46386e118e5b3a86ad7a6e2108ab128b848ad394748c8ade25046d5a8d0e499ec79cc7aa63400371b',
}
const params = (over = {}) => ({
  fromChain: 56, fromToken: '0x55d398326f99059fF775485246999027B3197955', amountIn: '1000000000000000000000',
  toChain: 8453, toToken: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', recipient: '0x000000000000000000000000000000000000dEaD',
  ...over,
})

// ---------- §3.7：typehash 自检 / the typehash self-check ----------
test('QUOTE_TYPEHASH is keccak256 of the primary type string in spec/TAPI-24.md §3.3', () => {
  assert.equal(abi.toHex(abi.keccak256(QUOTE_TYPE_STRING)), QUOTE_TYPEHASH)
  assert.equal(QUOTE_TYPEHASH, '0xe7c18a58c429974068166f7c27b8ba2a9a13177c83aeb69cdcac7a4bc7592d59') // spec/TAPI-24.md §6
  // 字段名与顺序必须与主类型字符串一致 / field names and order must match the primary type string
  const parsed = QUOTE_TYPE_STRING.slice('Quote('.length, -1).split(',').map(s => s.trim().split(/\s+/)[1])
  assert.deepEqual(parsed, QUOTE_FIELDS)
  assert.equal(QUOTE_FIELDS.length, 10)
})
test('keccak256("IntentEscrow") matches the domain-name hash in spec/TAPI-24.md §6', () => {
  assert.equal(abi.toHex(abi.keccak256(ESCROW_NAME)), ESCROW_NAME_HASH)
  assert.equal(ESCROW_NAME_HASH, '0x2043479336d59fcf0f30222e9c9f674b6a85c2fa5b5033d0c47e20469de7f0ba')
  // 启动自检本身也必须通过 / the start-up self-check itself must pass
  assert.deepEqual(selfCheck(), { typehash: QUOTE_TYPEHASH, nameHash: ESCROW_NAME_HASH })
})

// ---------- §3.7：固定 (key, quote, domain) → 固定 digest 与签名 ----------
test('a fixed (key, quote, domain) gives a fixed structHash, digest and 65-byte signature that recovers to solver', () => {
  assert.equal(sig.privateKeyToAddress(KEY), SOLVER)
  assert.equal(abi.toHex(quoteStructHash(QUOTE)), GOLDEN.structHash)
  const { digest, signature } = signQuote(QUOTE, DOMAIN, KEY)
  assert.equal(digest, GOLDEN.digest)
  assert.equal(signature, GOLDEN.sig)
  assert.equal(abi.toHex(quoteDigest(DOMAIN, QUOTE)), GOLDEN.digest)

  // 65 字节 r‖s‖v / 65 bytes r‖s‖v
  assert.equal(signature.length, 2 + 130)
  const { v } = sig.parseSignature(signature)
  assert.ok(v === 27 || v === 28, `v must be 27 or 28, got ${v}`)
  // 低 s：s <= n/2（合约 ECDSA.recover 的规则）/ low-s: s <= n/2, the rule the contract's ECDSA.recover applies
  const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n
  const s = BigInt('0x' + signature.slice(2).slice(64, 128))
  assert.ok(s > 0n && s <= N >> 1n, 'signature must be low-s')

  // 恢复必须等于 quote.solver（TAPI-24 §3.3 的 MUST）/ recovery MUST equal quote.solver
  assert.equal(sig.recoverAddress(digest, signature), QUOTE.solver)
  assert.deepEqual(verifyQuote(QUOTE, DOMAIN, signature), { digest: GOLDEN.digest, recovered: SOLVER, ok: true })
  // 另一把钥匙签的同一份报价恢复不到 solver / the same quote signed by another key does not recover to solver
  const other = signQuote(QUOTE, DOMAIN, '0x' + '22'.repeat(32))
  assert.equal(verifyQuote(QUOTE, DOMAIN, other.signature).ok, false)
})

// ---------- §3.7：逐字段的 digest 敏感性（10 个字段全覆盖）----------
test('changing any one of the 10 Quote fields changes the digest', () => {
  const base = abi.toHex(quoteDigest(DOMAIN, QUOTE))
  const mutations = {
    quoteId: '0x' + 'ac'.repeat(32),
    fromChain: 57,
    fromToken: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
    amountIn: '1000000000000000000001',
    toChain: 8454,
    toToken: '0x4200000000000000000000000000000000000006',
    amountOut: '997000001',
    recipient: '0x000000000000000000000000000000000000dEaE',
    expires: 1789999998,
    solver: '0x000000000000000000000000000000000000beEf',
  }
  assert.deepEqual(Object.keys(mutations), QUOTE_FIELDS) // 一个不落 / every field, in order
  for (const [field, value] of Object.entries(mutations)) {
    const mutated = { ...QUOTE, [field]: value }
    assert.notEqual(value, QUOTE[field], `${field}: the mutation must actually differ`)
    assert.notEqual(abi.toHex(quoteDigest(DOMAIN, mutated)), base, `${field} does not affect the digest`)
  }
})

// ---------- §3.7：重放防护回归（域里的 chainId 与 verifyingContract）----------
test('the same quote under a different chainId or verifyingContract yields a different digest (TAPI-24 §8 replay)', () => {
  const base = abi.toHex(quoteDigest(DOMAIN, QUOTE))
  assert.equal(base, GOLDEN.digest)
  assert.equal(abi.toHex(quoteDigest(quoteDomain(8453, ZERO), QUOTE)), '0x44d5e433efd52a47c2a4ff48b923a0b461ef65aaf7e974af6ce84105de4b43bd')
  assert.equal(abi.toHex(quoteDigest(quoteDomain(56, '0x00000000000000000000000000000000000000Ee'), QUOTE)), '0x48cf962be907df6e8fcb601d6396f7619537828283d98db9b25753d83c8438b7')
  assert.notEqual(abi.toHex(quoteDigest(quoteDomain(8453, ZERO), QUOTE)), base)
  assert.notEqual(abi.toHex(quoteDigest(quoteDomain(56, '0x00000000000000000000000000000000000000Ee'), QUOTE)), base)
  // domain 的形状就是 TAPI-24 §3.3 的四个字段 / the domain is exactly the four fields of TAPI-24 §3.3
  assert.deepEqual(DOMAIN, { name: 'IntentEscrow', version: '1', chainId: 56, verifyingContract: ZERO })
})

// ---------- §3.7：定价 ----------
test('1000e18 USDT at 1:1, 30 bps, 18 -> 6 decimals gives exactly 997000000', () => {
  const out = priceAmountOut({ amountIn: '1000000000000000000000', rateNumerator: '1', rateDenominator: '1', fromDecimals: 18, toDecimals: 6, solverSpreadBps: 30 })
  assert.equal(out, 997000000n)
  assert.equal(out.toString(), '997000000')
})
test('pricing is BigInt throughout and truncates toward zero at every division', () => {
  // 1 wei in, 18 -> 6：10^-12 单位，截断成 0 / 1 wei in at 18 -> 6 decimals truncates to zero
  assert.equal(priceAmountOut({ amountIn: '1', rateNumerator: '1', rateDenominator: '1', fromDecimals: 18, toDecimals: 6, solverSpreadBps: 30 }), 0n)
  // 价差截断：1 单位输出 * 9970/10000 = 0（不是 1）/ the spread truncates 1 unit down to 0, not up to 1
  assert.equal(priceAmountOut({ amountIn: '1', rateNumerator: '1', rateDenominator: '1', fromDecimals: 0, toDecimals: 0, solverSpreadBps: 30 }), 0n)
  assert.equal(priceAmountOut({ amountIn: '100', rateNumerator: '1', rateDenominator: '1', fromDecimals: 0, toDecimals: 0, solverSpreadBps: 30 }), 99n)
  // 汇率的整除也向零截断 / the rate division truncates toward zero too
  assert.equal(priceAmountOut({ amountIn: '10', rateNumerator: '1', rateDenominator: '3', fromDecimals: 0, toDecimals: 0, solverSpreadBps: 0 }), 3n)
  // 零价差 / zero spread
  assert.equal(priceAmountOut({ amountIn: '1000000000000000000000', rateNumerator: '1', rateDenominator: '1', fromDecimals: 18, toDecimals: 6, solverSpreadBps: 0 }), 1000000000n)
  // 超出 uint64 的金额也不会退化成 Number / amounts past 2^64 never fall back to Number
  assert.equal(priceAmountOut({ amountIn: '123456789012345678901234567890', rateNumerator: '1', rateDenominator: '1', fromDecimals: 0, toDecimals: 0, solverSpreadBps: 0 }), 123456789012345678901234567890n)
})

// ---------- §3.7：错误码 ----------
test('ttl outside 30..120 is BAD_REQUEST, and the default is 60', () => {
  for (const ttl of [29, 121, 0, -1, 60.5, '60', NaN, Infinity, true]) {
    assert.throws(() => validateQuoteParams(params({ ttl }), config), (e) => e.code === 'BAD_REQUEST', `ttl ${ttl}`)
  }
  for (const ttl of [30, 60, 120]) assert.equal(validateQuoteParams(params({ ttl }), config).ttl, ttl)
  assert.equal(validateQuoteParams(params(), config).ttl, TTL_DEFAULT)
  assert.equal(TTL_DEFAULT, 60)
})
test('an unserved route is METHOD_NOT_FOUND, not BAD_REQUEST (TAPI-24 §3.2)', () => {
  const cases = [
    params({ fromChain: 1 }),                                                        // chain pair not served
    params({ toChain: 137 }),
    params({ fromToken: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d' }),             // token pair not served
    params({ toToken: '0x4200000000000000000000000000000000000006' }),
    params({ fromChain: 8453, toChain: 56 }),                                         // reverse direction not served
  ]
  for (const p of cases) assert.throws(() => validateQuoteParams(p, config), (e) => e.code === 'METHOD_NOT_FOUND', JSON.stringify(p))
  assert.throws(() => findPair(config, { fromChain: 56, toChain: 999, fromToken: QUOTE.fromToken, toToken: QUOTE.toToken }), (e) => e.code === 'METHOD_NOT_FOUND')
  // 服务的那条路线找得到 / the served route resolves
  assert.equal(findPair(config, { fromChain: 56, toChain: 8453, fromToken: QUOTE.fromToken.toLowerCase(), toToken: QUOTE.toToken.toLowerCase() }).pair.fromDecimals, 18)
})
test('amountIn must be a positive integer string within maxAmountIn', () => {
  const bads = ['0', '-1', '1.5', '1e18', '', ' 1', '0x10', '01', 1000, null, undefined, '1000000000000000000000000000']
  for (const amountIn of bads) assert.throws(() => validateQuoteParams(params({ amountIn }), config), (e) => e.code === 'BAD_REQUEST', String(amountIn))
  // 恰好等于上限可以，多一个最小单位不行 / exactly maxAmountIn passes, one unit more does not
  const max = config.routes[0].pairs[0].maxAmountIn
  assert.equal(validateQuoteParams(params({ amountIn: max }), config).amountIn, max)
  assert.throws(() => validateQuoteParams(params({ amountIn: (BigInt(max) + 1n).toString() }), config), (e) => e.code === 'BAD_REQUEST')
})
test('malformed addresses and chain ids are BAD_REQUEST', () => {
  for (const p of [params({ recipient: 'nope' }), params({ fromToken: '0x1234' }), params({ fromChain: '56' }), params({ toChain: 0 }), params({ recipient: undefined })]) {
    assert.throws(() => validateQuoteParams(p, config), (e) => e.code === 'BAD_REQUEST', JSON.stringify(p))
  }
  assert.throws(() => validateQuoteParams(null, config), (e) => e.code === 'BAD_REQUEST')
  assert.throws(() => validateQuoteParams([], config), (e) => e.code === 'BAD_REQUEST')
})

// ---------- buildQuote：字段顺序、过期、可验证性 ----------
test('buildQuote emits the primary-type fields in order, expires = now + ttl, and signs verifiably', () => {
  const now = 1789999939
  const quoteId = '0x' + 'ab'.repeat(32)
  const { quote, escrow, domain } = buildQuote({ config, solver: SOLVER, params: params({ ttl: 60 }), now, quoteId })
  assert.deepEqual(Object.keys(quote), QUOTE_FIELDS) // 一字不差的字段顺序 / exactly the primary-type order
  assert.deepEqual(quote, QUOTE)                     // 与上面的金值报价完全相同 / identical to the golden quote
  assert.equal(quote.expires, now + 60)
  assert.equal(escrow, ZERO)
  assert.deepEqual(domain, DOMAIN)
  assert.equal(typeof quote.fromChain, 'number')
  assert.equal(typeof quote.amountIn, 'string')      // 最小单位十进制串，不做定点渲染 / raw minimal units, never a fixed-point render
  assert.equal(typeof quote.amountOut, 'string')
  const { digest, signature } = signQuote(quote, domain, KEY)
  assert.equal(digest, GOLDEN.digest)
  assert.equal(sig.recoverAddress(digest, signature), quote.solver)
})
test('addresses in the quote are checksummed regardless of how the caller cased them', () => {
  const { quote } = buildQuote({ config, solver: SOLVER.toLowerCase(), params: params({ fromToken: QUOTE.fromToken.toLowerCase(), recipient: QUOTE.recipient.toUpperCase().replace('0X', '0x') }), now: 1789999939, quoteId: '0x' + 'ab'.repeat(32) })
  assert.deepEqual(quote, QUOTE)
})

// ---------- 报价簿与 status ----------
test('status reports unknown / quoted / expired, always with onChain null and the fixed note', () => {
  const book = createQuoteBook(10000)
  const unknown = quoteStatus(book, '0x' + 'cd'.repeat(32), 1789999939)
  assert.deepEqual(unknown, { quoteId: '0x' + 'cd'.repeat(32), state: 'unknown', expires: 0, quote: null, onChain: null, note: STATUS_NOTE })
  book.put(QUOTE)
  assert.equal(quoteStatus(book, QUOTE.quoteId, QUOTE.expires - 1).state, 'quoted')
  assert.equal(quoteStatus(book, QUOTE.quoteId, QUOTE.expires).state, 'quoted')      // 边界含等号 / the boundary is inclusive
  assert.equal(quoteStatus(book, QUOTE.quoteId, QUOTE.expires + 1).state, 'expired')
  const s = quoteStatus(book, QUOTE.quoteId, QUOTE.expires - 1)
  assert.equal(s.onChain, null)
  assert.equal(s.note, 'IntentEscrow is not deployed; this is local bookkeeping only')
  assert.deepEqual(s.quote, QUOTE)
  assert.throws(() => quoteStatus(book, 'nope', 1), (e) => e.code === 'BAD_REQUEST')
  assert.throws(() => quoteStatus(book, '0xab', 1), (e) => e.code === 'BAD_REQUEST')
})
test('the quote book is an LRU capped at its max', () => {
  const book = createQuoteBook(3)
  const mk = (i) => ({ ...QUOTE, quoteId: '0x' + i.toString(16).padStart(64, '0') })
  for (let i = 1; i <= 5; i++) book.put(mk(i))
  assert.equal(book.size, 3)
  assert.equal(book.get(mk(1).quoteId), null)                 // 最旧的被淘汰 / oldest evicted
  assert.equal(book.get(mk(2).quoteId), null)
  assert.equal(book.get(mk(3).quoteId).quoteId, mk(3).quoteId)
  book.get(mk(3).quoteId)                                      // 读一次算使用 / a read refreshes it
  book.put(mk(6))
  assert.equal(book.get(mk(4).quoteId), null)                 // 于是 4 先走，3 还在 / 4 goes first, 3 survives
  assert.equal(book.get(mk(3).quoteId).quoteId, mk(3).quoteId)
})

// ---------- 配置 ----------
test('validateConfig rejects a price table that would produce unverifiable quotes', () => {
  const clone = () => JSON.parse(JSON.stringify(config))
  assert.equal(validateConfig(clone()).solverSpreadBps, 30)
  const cases = [
    (c) => { c.solverSpreadBps = 10000 },
    (c) => { c.solverSpreadBps = -1 },
    (c) => { c.solverSpreadBps = 1.5 },
    (c) => { c.routes = [] },
    (c) => { c.escrow = {} },                                  // fromChain 没有 IntentEscrow 地址
    (c) => { c.routes[0].pairs[0].fromToken = '0x1234' },
    (c) => { c.routes[0].pairs[0].maxAmountIn = '0' },
    (c) => { c.routes[0].pairs[0].rateDenominator = '0' },
    (c) => { c.routes[0].pairs = [] },
  ]
  for (const mutate of cases) { const c = clone(); mutate(c); assert.throws(() => validateConfig(c)) }
})
