// `examples/defi-portfolio-read/portfolio.mjs` 的单元测试。纯函数、**不联网**（SPEC §4.6）。
// 所有需要网络的东西都在 `index.mjs` 里，本文件一个 socket 也不开。
//
// Unit tests for `examples/defi-portfolio-read/portfolio.mjs`. Pure functions, no network (SPEC §4.6).
// Everything that needs a socket lives in `index.mjs`; this file opens none.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { canonicalJSON, TapeAPIError } from '@tapeapi/sdk'
import {
  MAX_TOKENS, MAX_CHAINS, MAX_POSITIONS,
  assertTokenList, assertChainList, assertPositionLimit,
  shareOf, amountsOf, decodePositions, decodeSymbol, decodeReserves, decodeDecimals,
  tokenEntry, failedTokenEntry, nativeEntry, positionEntry, isTokenDataFault,
  buildBalancesResult, buildLpV2Result,
} from './portfolio.mjs'

const A = (n) => '0x' + String(n).repeat(40).slice(0, 40) // 造一个合法地址 / a well-formed throwaway address
const USDT = '0x55d398326f99059fF775485246999027B3197955'
const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c'
const PINNED = { blockNumber: 123207091, blockHash: '0x0883376a84a37293f5689c9934fe2e949d48858fc10d49acdc9e4293e31322c3', tag: '0x75501b3' }

// ---------- share / amount 的 BigInt 换算与向零截断 / BigInt maths, truncated toward zero ----------

test('share = lpBalance * 1e18 / totalSupply, rendered as a fixed-width 18-decimal string', () => {
  // 半个池子 / exactly half the pool
  assert.equal(shareOf(50n, 100n), '0.500000000000000000')
  // 整数结果也**不剥零**——SDK 的 formatUnits 会把它变成 "1"，跨提供者比较就对不上位数了。
  // A whole number keeps its zeros; the SDK's formatUnits would render this as "1".
  assert.equal(shareOf(100n, 100n), '1.000000000000000000')
  assert.equal(shareOf(0n, 100n), '0.000000000000000000')
  // 1/3：向零截断，最后一位是 3 不是 4 / one third: truncated toward zero, the last digit is 3 and never rounds up
  assert.equal(shareOf(1n, 3n), '0.333333333333333333')
  // 2/3 = 0.666…667 若四舍五入；向零截断得 …666
  assert.equal(shareOf(2n, 3n), '0.666666666666666666')
  // 真实 BNB Chain 主网数值：PancakeSwap V2 WBNB/USDT 上被永久锁死的 LP（_mint(address(0), MINIMUM_LIQUIDITY)）
  // real mainnet values: the permanently locked LP on the PancakeSwap V2 WBNB/USDT pair
  assert.equal(shareOf(348500000001000n, 526747097780295974655499n), '0.000000000661607821')
})

test('amount0 / amount1 = reserve * lpBalance / totalSupply, BigInt, truncated toward zero', () => {
  assert.deepEqual(amountsOf(1000n, 2000n, 50n, 100n), { amount0: '500', amount1: '1000' })
  // 余数被丢掉，不进位：7 * 1 / 3 = 2.33… → 2
  // the remainder is discarded, never rounded: 7 * 1 / 3 = 2.33… -> 2
  assert.deepEqual(amountsOf(7n, 8n, 1n, 3n), { amount0: '2', amount1: '2' })
  // 先乘后除：先除会在整数除法里把份额直接归零 / multiply-then-divide; dividing first would floor the share to 0
  assert.deepEqual(amountsOf(10n ** 24n, 1n, 1n, 10n ** 6n), { amount0: '1000000000000000000', amount1: '0' })
  // 份额小到 amount 为 0 时就是 0，不是 NaN、不是负数 / a share too small to claim a wei yields "0"
  assert.deepEqual(amountsOf(1n, 1n, 1n, 10n ** 30n), { amount0: '0', amount1: '0' })
})

test('a zero totalSupply is a BAD_REQUEST, not a division by zero', () => {
  assert.throws(() => shareOf(1n, 0n), (e) => e.code === 'BAD_REQUEST')
  assert.throws(() => amountsOf(1n, 1n, 1n, 0n), (e) => e.code === 'BAD_REQUEST')
})

// ---------- 数组顺序 == 入参顺序，含重复入参 / caller order, duplicates preserved ----------

test('the tokens result is in caller order, duplicates preserved, nothing deduped or reordered', () => {
  const input = [USDT, WBNB, USDT, A(3), WBNB] // 故意重复 / duplicates on purpose
  const list = assertTokenList(input)
  assert.deepEqual(list, input)

  // 组装出的条目逐项对齐入参下标，包括那两个重复项 / the assembled entries line up index-for-index
  const entries = list.map((t, i) => tokenEntry(t, { balance: BigInt(i + 1), decimals: 18, symbol: 'T' + i }))
  const result = buildBalancesResult({ chainId: 56, pinned: PINNED, blockRef: 'hash', address: A(1), native: nativeEntry('BNB', 0n), tokens: entries })
  assert.deepEqual(result.tokens.map((e) => e.token.toLowerCase()), input.map((t) => t.toLowerCase()))
  assert.deepEqual(result.tokens.map((e) => e.balance), ['1', '2', '3', '4', '5'])
  // 同一个 token 出现两次，两次都在，余额各自独立 / the repeated token appears twice, each with its own slot
  assert.equal(result.tokens[0].token, result.tokens[2].token)
  assert.notEqual(result.tokens[0].balance, result.tokens[2].balance)
})

test('a token whose read failed keeps its slot, carries a fixed TOKEN_READ_FAILED and does not fail the request', () => {
  const input = [USDT, A(4), WBNB]
  const entries = [
    tokenEntry(input[0], { balance: 5n, decimals: 18, symbol: 'USDT' }),
    failedTokenEntry(input[1]), // 中间那个读失败 / the middle one failed
    tokenEntry(input[2], { balance: 7n, decimals: 18, symbol: 'WBNB' }),
  ]
  assert.equal(entries.length, 3) // 不掉项，否则顺序保证就没了 / the slot is never dropped
  assert.deepEqual(entries[1], { token: entries[1].token, symbol: null, decimals: null, balance: null, formatted: null, error: 'TOKEN_READ_FAILED' })
  // 固定字符串：上游错误消息可能带 RPC 主机名，放进签名 result 会违反 SPEC §0.3.3
  // a fixed string: an upstream message could carry an RPC hostname, which a signed result must not
  assert.equal(entries[1].error, 'TOKEN_READ_FAILED')
  assert.equal(entries[0].balance, '5')
  assert.equal(entries[2].balance, '7')
  // symbol 读不出来但余额读到了：symbol 为 null 且带 error，余额照常 / symbol null + error, balance still returned
  const partial = tokenEntry(USDT, { balance: 9n, decimals: 18, symbol: null })
  assert.equal(partial.symbol, null)
  assert.equal(partial.error, 'TOKEN_READ_FAILED')
  assert.equal(partial.balance, '9')
})

test('only a fault in the token data degrades to TOKEN_READ_FAILED; a transport failure is rethrown', () => {
  // 合约本身的问题 → 降级。这在锚定块上是确定事实，每家提供者都会同样失败，不破坏逐字节一致。
  // A fault in the contract itself degrades: it is a fact about the pinned block, so every provider agrees.
  assert.ok(isTokenDataFault(new Error('wordAt: word 0 is out of range')))            // 返回 0x，解码器抛 / decoder on empty data
  assert.ok(isTokenDataFault(new TapeAPIError('ABI_INVALID', 'bad return data')))
  assert.ok(isTokenDataFault(Object.assign(new TapeAPIError('RPC_ERROR', 'execution reverted'), { rpcCode: 3 })))

  // 传输故障 → **不**降级，向上抛。否则我这边抖一下就标 TOKEN_READ_FAILED，另一家返回真实余额，
  // 两份已验签结果逐字节不同，callQuorum 必然 QUORUM_FAILED，而谁都没说谎。
  // A transport failure does NOT degrade: otherwise one blip here and another provider's honest balance
  // become two byte-different verified envelopes, and callQuorum rejects although nobody lied.
  assert.ok(!isTokenDataFault(new TapeAPIError('RPC_UNAVAILABLE', 'only 1/2 nodes answered')))
  assert.ok(!isTokenDataFault(new TapeAPIError('INTERNAL', 'This operation was aborted')))
  assert.ok(!isTokenDataFault(Object.assign(new TapeAPIError('RPC_ERROR', 'rate limited'), { rpcCode: -32005 })))

  // 实测到的具体情形：以太坊 USDT 完全标准（decimals 6、symbol "USDT"），一次上游超时不应把它标成非标准代币。
  // The measured case: Ethereum USDT is standard; an upstream timeout must not label it a non-standard token.
  assert.ok(!isTokenDataFault(new TapeAPIError('RPC_UNAVAILABLE', 'eth_call: only 1/2 nodes answered')))
})

// ---------- 上限校验 / limit validation ----------

test('31 tokens, 6 chains and an lpV3 limit of 21 are each a BAD_REQUEST', () => {
  const tokens30 = Array.from({ length: MAX_TOKENS }, (_, i) => A((i % 9) + 1))
  assert.equal(assertTokenList(tokens30).length, 30) // 30 正好通过 / exactly 30 is fine
  assert.throws(() => assertTokenList([...tokens30, USDT]), (e) => e.code === 'BAD_REQUEST' && /at most 30/.test(e.message))

  const chains5 = Array.from({ length: MAX_CHAINS }, () => ({ chainId: 56, tokens: [] }))
  assert.equal(assertChainList(chains5).length, 5)
  assert.throws(() => assertChainList([...chains5, { chainId: 1, tokens: [] }]), (e) => e.code === 'BAD_REQUEST' && /at most 5/.test(e.message))

  assert.equal(assertPositionLimit(MAX_POSITIONS), 20)
  assert.equal(assertPositionLimit(undefined), 20) // 省略 → 20 / omitted defaults to the cap
  assert.throws(() => assertPositionLimit(MAX_POSITIONS + 1), (e) => e.code === 'BAD_REQUEST' && /at most 20/.test(e.message))
  assert.throws(() => assertPositionLimit(0), (e) => e.code === 'BAD_REQUEST')

  // 上限是逐链算的，不是总数：5 条链每条 30 个 token 都合法 / the token cap is per chain, not global
  assert.equal(assertChainList(Array.from({ length: 5 }, () => ({ chainId: 56, tokens: tokens30 }))).length, 5)
  // 单条链超限也要抛 / a single over-limit chain still throws
  assert.throws(() => assertChainList([{ chainId: 56, tokens: [...tokens30, USDT] }]), (e) => e.code === 'BAD_REQUEST')
  // 非地址、非数组、缺 chainId / non-addresses, non-arrays and a missing chainId
  assert.throws(() => assertTokenList(['nope']), (e) => e.code === 'BAD_REQUEST')
  assert.throws(() => assertTokenList('0x1234'), (e) => e.code === 'BAD_REQUEST')
  assert.throws(() => assertChainList([{ tokens: [] }]), (e) => e.code === 'BAD_REQUEST')
  assert.throws(() => assertChainList([]), (e) => e.code === 'BAD_REQUEST')
})

// ---------- positions() 的 int24 解码 / int24 decoding ----------

// 固化向量。字 0–4 与 7–11 是 2026-09-20 从 BNB Chain 主网 NonfungiblePositionManager
// `0x46A15B0b27311cedF172AB29E4f4766fbE7F4364` 的 `positions(1888013)` 真实返回数据抄下来的，
// **只把第 5、6 个字（tickLower / tickUpper）换成了满区间 ±887220**（tickSpacing 60 的满区间），
// 以便断言一个确定的有符号边界值。两个 tick 字是手打的十六进制常量，不是用 `fromInt256` 生成的——
// 用编码函数生成再用解码函数解回来只能证明两者互逆，证明不了 256 位这个宽度是对的。
//
// Frozen vector. Words 0–4 and 7–11 are real return data captured from BNB Chain mainnet
// (`positions(1888013)` on the NonfungiblePositionManager) on 2026-09-20; only words 5 and 6 are
// substituted with the full range ±887220 (the full range at tickSpacing 60) so the test can assert a
// definite signed boundary. Both tick words are hand-typed hex constants, not produced by `fromInt256`:
// generating with the encoder and reading back with the decoder would only prove they are mutual inverses,
// never that the width is 256 bits.
const POSITIONS_HEX = '0x'
  + '0000000000000000000000000000000000000000000000000000000000000000'  // 0 nonce
  + '0000000000000000000000000000000000000000000000000000000000000000'  // 1 operator
  + '0000000000000000000000008ac76a51cc950d9822d68b83fe1ad97b32cd580d'  // 2 token0 (USDC on BSC)
  + '000000000000000000000000a0c56a8c0692bd10b3fa8f8ba79cf5332b7107f9'  // 3 token1
  + '0000000000000000000000000000000000000000000000000000000000000064'  // 4 fee = 100
  + 'fffffffffffffffffffffffffffffffffffffffffffffffffffffffffff2764c'  // 5 tickLower = -887220 (2^256 - 887220)
  + '00000000000000000000000000000000000000000000000000000000000d89b4'  // 6 tickUpper =  887220 (0xd89b4)
  + '0000000000000000000000000000000000000000000000000000000000000000'  // 7 liquidity
  + '00000000000000000000000000000000000000ec411e44e8be9d3087115ef257'  // 8 feeGrowthInside0LastX128
  + '0000000000000000000000000000000000000738e9a7a6da226737f54c7f4a6e'  // 9 feeGrowthInside1LastX128
  + '0000000000000000000000000000000000000000000000000000000000000000'  // 10 tokensOwed0
  + '0000000000000000000000000000000000000000000000000000000000000000'  // 11 tokensOwed1

test('positions() decodes int24 ticks as 256-bit two\'s complement: tickLower -887220, tickUpper 887220', () => {
  const p = decodePositions(POSITIONS_HEX)
  assert.equal(p.tickLower, -887220n)
  assert.equal(p.tickUpper, 887220n)
  // 不做二补码转换、直接当无符号读，得到的就是这个天文数字（= 2^256 − 887220）。SPEC §0.5 记录的失败模式
  // 正是把它当成 tick 用。`intWordAt` 按 256 位转换后才是 -887220。
  // Read as an unsigned word — i.e. without the two's-complement step — the same bytes are this astronomical
  // number (= 2^256 − 887220). Using it as a tick is exactly the failure mode SPEC §0.5 records; converting
  // at 256 bits is what turns it back into -887220.
  const rawUnsigned = BigInt('0x' + POSITIONS_HEX.slice(2).slice(5 * 64, 6 * 64))
  assert.equal(rawUnsigned, 115792089237316195423570985008687907853269984665640564039457584007913128752716n)
  assert.equal(rawUnsigned, (1n << 256n) - 887220n)
  assert.equal(rawUnsigned - (1n << 256n), p.tickLower)
  assert.ok(p.tickLower < 0n, 'a lower tick below zero must come out negative')
  assert.equal(p.tickUpper, -p.tickLower) // 满区间是对称的 / the full range is symmetric

  // 其余字段仍按真实主网布局解出来 / the remaining fields still decode against the real mainnet layout
  assert.equal(p.fee, 100n)
  assert.equal(p.token0, '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d')
  assert.equal(p.liquidity, 0n)
  assert.equal(p.feeGrowthInside0LastX128, BigInt('0xec411e44e8be9d3087115ef257'))

  // 字符串化后仍带负号 / the sign survives stringification into the signed result
  const entry = positionEntry(1888013n, p)
  assert.equal(entry.tickLower, '-887220')
  assert.equal(entry.tickUpper, '887220')
  assert.equal(entry.tokenId, '1888013')
  // 原始参数，**不换算**成 token 数量：结果里不得出现 amount0/amount1
  // raw parameters only: no amount0/amount1 is derived here (that needs slot0 + TickMath, see defi-twap-oracle)
  assert.equal(entry.amount0, undefined)
  assert.equal(entry.amount1, undefined)
})

test('a positions() return with the wrong word count or a non-address word fails loudly', () => {
  assert.throws(() => decodePositions('0x' + '00'.repeat(32 * 11)), /expected 12 words/)
  // 把第 1 个字（operator）改成非地址：高 12 字节不为零 / word 1 (operator) is no longer an address
  const broken = '0x' + POSITIONS_HEX.slice(2, 2 + 64) + 'ff'.repeat(32) + POSITIONS_HEX.slice(2 + 2 * 64)
  assert.throws(() => decodePositions(broken), /layout mismatch/)
})

// ---------- 其它解码 / the remaining decoders ----------

test('symbol() accepts both the string and the legacy bytes32 encoding', () => {
  // 标准 string：偏移 0x20、长度 4、右填充的 "USDT" / standard string: offset, length, right-padded bytes
  const asString = '0x' + '20'.padStart(64, '0') + '4'.padStart(64, '0') + Buffer.from('USDT').toString('hex').padEnd(64, '0')
  assert.equal(decodeSymbol(asString), 'USDT')
  // 老式 bytes32（MKR 之流）/ the legacy bytes32 form
  assert.equal(decodeSymbol('0x' + Buffer.from('MKR').toString('hex').padEnd(64, '0')), 'MKR')
  // 解不出来就是 null，由调用方记成 TOKEN_READ_FAILED，而不是抛出去炸掉整个请求
  // anything else is null and becomes TOKEN_READ_FAILED, never an exception that fails the whole request
  assert.equal(decodeSymbol('0x'), null)
})

test('getReserves and decimals decode from their word layout', () => {
  const r = '0x' + (1000n).toString(16).padStart(64, '0') + (2000n).toString(16).padStart(64, '0') + (42n).toString(16).padStart(64, '0')
  assert.deepEqual(decodeReserves(r), { reserve0: 1000n, reserve1: 2000n, blockTimestampLast: 42 })
  assert.equal(decodeDecimals('0x' + (18n).toString(16).padStart(64, '0')), 18)
  assert.throws(() => decodeDecimals('0x' + (999n).toString(16).padStart(64, '0')), /implausible/)
})

// ---------- 确定性：同输入两次 canonicalJSON 逐字节相同 / determinism ----------

test('the same input canonicalises to identical bytes twice — this is what makes a quorum possible', () => {
  const build = () => buildLpV2Result({
    chainId: 56, pinned: PINNED, blockRef: 'hash', address: A(1), pair: '0x16b9a82891338f9bA80E2D6970FddA79D1eb0daE',
    token0: { address: WBNB, symbol: 'WBNB', decimals: 18, reserve: '1000' },
    token1: { address: USDT, symbol: 'USDT', decimals: 18, reserve: '2000' },
    lpBalance: 348500000001000n, totalSupply: 526747097780295974655499n, reserve0: 1000n, reserve1: 2000n,
  })
  const a = canonicalJSON(build())
  const b = canonicalJSON(build())
  assert.equal(a, b) // 逐字节 / byte for byte
  assert.equal(Buffer.compare(Buffer.from(a), Buffer.from(b)), 0)

  // 键的插入顺序不影响 canonicalJSON（它递归排序），但**数组顺序**影响——所以数组顺序必须是确定的。
  // Key insertion order does not matter (canonicalJSON sorts recursively); array order does, which is why
  // the token array is built from the caller's order rather than from Promise completion order.
  const tokens = [USDT, WBNB].map((t, i) => tokenEntry(t, { balance: BigInt(i), decimals: 18, symbol: 'X' }))
  const fwd = buildBalancesResult({ chainId: 56, pinned: PINNED, blockRef: 'hash', address: A(1), native: nativeEntry('BNB', 1n), tokens })
  const rev = buildBalancesResult({ chainId: 56, pinned: PINNED, blockRef: 'hash', address: A(1), native: nativeEntry('BNB', 1n), tokens: tokens.slice().reverse() })
  assert.notEqual(canonicalJSON(fwd), canonicalJSON(rev))

  // 签名 result 里不得出现本地时钟、耗时、provider 名字/URL、RPC 主机名、随机数（SPEC §0.3.3）。
  // A signed result must carry no local clock, elapsed time, provider name/URL, RPC hostname or randomness.
  const json = canonicalJSON(fwd) + canonicalJSON(build())
  for (const forbidden of ['http', 'rpc', 'bnbchain', 'dataseed', 'Date', 'elapsed', 'ms', 'timestamp', 'latency']) {
    assert.ok(!json.includes(forbidden), `signed result must not contain ${JSON.stringify(forbidden)}`)
  }
})

test('the four TAP-23 §3.3 fields are flat and top-level, never wrapped in blockPinned', () => {
  const r = buildBalancesResult({ chainId: 56, pinned: PINNED, blockRef: 'hash', address: A(1), native: nativeEntry('BNB', 0n), tokens: [] })
  assert.equal(r.chainId, 56)
  assert.equal(r.blockNumber, 123207091)
  assert.equal(r.blockHash, PINNED.blockHash)
  assert.equal(r.blockRef, 'hash')
  assert.equal(r.blockPinned, undefined) // §1/§2 的 BSC 本链约定在这里是错的 / the sibling convention does not apply here
  // `tag` 是内部字段，不进签名 result / the internal `tag` never reaches the signed result
  assert.equal(r.tag, undefined)
  assert.equal(nativeEntry('BNB', 10n ** 18n).formatted, '1') // formatUnits，按 SPEC §4.3 保留 / kept per SPEC §4.3
  assert.equal(nativeEntry('BNB', 10n ** 18n).symbol, 'BNB')  // 来自 chains.json 静态配置 / from static config
})
