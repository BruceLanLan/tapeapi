// Escrow v3 in the SDK (experimental; the escrow is neither deployed nor audited): the instance's token and its decimals
// read from the chain, never assumed; the ABI entries and builders the v3 contract adds.
// SDK 对托管 v3 的支持（实验性；托管未部署、未审计）：代币与小数位一律从链上读取，绝不假设；v3 新增的 ABI 与交易构造。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { createTapeAPI, TapeAPIError, formatPaymentAmount, PAYMENT_TOKENS, AUDITED_ESCROWS, MAINNET } from '../src/index.js'
import { signatureOf, selector, encodeCall, decodeReturn, functionBySelector, EVENTS, eventTopic, keccak256, toHex, checksumAddress } from '../src/abi.js'
import { createFakeChain, ADDR, BEM } from './helpers/fake-chain.mjs'

const RPC = ['http://rpc1', 'http://rpc2', 'http://rpc3']
const USDT = '0x55d398326f99059fF775485246999027B3197955'
const OTHER = '0x' + 'e7'.repeat(20)
const ESC2 = '0x' + '42'.repeat(20)
const mk = (chain, extra = {}) => createTapeAPI({ rpcUrls: RPC, quorum: 2, chainId: 56, escrow: ADDR.escrow, hub: ADDR.hub, siteRegistry: ADDR.siteRegistry, fetch: chain.fetch, ...extra })
const unsupported = (reason) => (e) => e instanceof TapeAPIError && e.code === 'UNSUPPORTED_PAYMENT_TOKEN' && e.data?.reason === reason

test('escrow v3 ABI: token() shares the ERC-6551 selector but decodes one address; treasuryAccrued, claimTreasury, TreasuryClaimed', () => {
  assert.equal(signatureOf('escrowToken'), 'token()')
  assert.equal(selector('escrowToken'), selector('token'), 'one selector, two return shapes')
  assert.equal(selector('escrowToken'), '0xfc0c546a')
  assert.equal(functionBySelector(encodeCall('escrowToken')), 'token', 'calldata lookup still names the first entry')
  assert.equal(decodeReturn('escrowToken', '0x' + '00'.repeat(12) + USDT.slice(2).toLowerCase()), USDT)
  assert.equal(signatureOf('treasuryAccrued'), 'treasuryAccrued()')
  assert.equal(signatureOf('claimTreasury'), 'claimTreasury()')
  assert.equal(EVENTS.TreasuryClaimed, 'TreasuryClaimed(address,uint256)')
  assert.equal(eventTopic('TreasuryClaimed'), toHex(keccak256('TreasuryClaimed(address,uint256)')))
  assert.equal(eventTopic('Settled'), toHex(keccak256('Settled(address,address,uint256,uint256,uint16)')))
  assert.throws(() => eventTopic('Nope'), /unknown event/)
})

test('escrow v3 ABI matches the Solidity source: token, treasuryAccrued, claimTreasury, Settled, TreasuryClaimed', () => {
  // A text check against contracts/src/TapeAPIEscrow.sol, so a rename on either side fails here (no compiler needed).
  // 对合约源码做文本核对：任一侧改名都会在这里失败（不需要编译器）。
  const sol = readFileSync(new URL('../../contracts/src/TapeAPIEscrow.sol', import.meta.url), 'utf8')
  assert.match(sol, /IERC20 public immutable token;/, 'token() is the public getter of an immutable address')
  assert.match(sol, /uint256 public treasuryAccrued;/)
  assert.match(sol, /function claimTreasury\(\) external nonReentrant returns \(uint256/)
  assert.match(sol, /event TreasuryClaimed\(address indexed treasury, uint256 amount\);/)
  assert.match(sol, /event Settled\(address indexed consumer, address indexed provider, uint256 paid, uint256 contribution, uint16 bps\);/)
})

test('chain.escrow.token / treasuryAccrued read the escrow; tx.claimTreasury is a plain call anyone may send', async () => {
  const chain = createFakeChain()
  chain.setTreasuryAccrued(ADDR.escrow, 12345n)
  const api = mk(chain)
  assert.equal((await api.chain.escrow.token()).toLowerCase(), BEM)
  assert.equal(await api.chain.escrow.treasuryAccrued(), 12345n)
  chain.setEscrowToken(ESC2, USDT)
  assert.equal(await api.chain.escrow.token(ESC2), USDT)
  const svc = { container: ADDR.container, manifest: { payment: { escrow: ESC2 } } }
  assert.equal(await api.chain.escrow.token(svc), USDT, 'a resolved service: its own escrow (TAPI-22 §3.4)')
  const t = api.tx.claimTreasury()
  assert.deepEqual(t, { to: '0x4040404040404040404040404040404040404040', data: selector('claimTreasury'), value: '0x0' })
  assert.equal(api.tx.claimTreasury(svc).to, '0x4242424242424242424242424242424242424242')
  assert.throws(() => createTapeAPI({}).tx.claimTreasury(), (e) => e.code === 'INVALID_ARGUMENT' && /escrow address not configured/.test(e.message))
  assert.throws(() => api.tx.claimTreasury({ container: ADDR.container, manifest: { payment: { escrow: null } } }), /takes no payment/)
})

test('paymentToken: token() then decimals(), both read from the chain; a label from PAYMENT_TOKENS, never name()', async () => {
  const chain = createFakeChain()
  chain.setEscrowToken(ESC2, USDT); chain.setDecimals(USDT, 18)
  const api = mk(chain)
  const bem = await api.chain.escrow.paymentToken()
  assert.deepEqual({ ...bem }, { escrow: '0x4040404040404040404040404040404040404040', token: checksumAddress(BEM), decimals: 8, label: 'BEM', display: `BEM ${checksumAddress(BEM)}` })
  assert.ok(Object.isFrozen(bem))
  const usdt = await api.chain.escrow.paymentToken(ESC2)
  assert.equal(usdt.token, USDT)
  assert.equal(usdt.decimals, 18, 'read from decimals(), not the 8 of BEM')
  assert.equal(usdt.label, 'USDT (Binance-Peg)')
  assert.equal(usdt.display, `USDT (Binance-Peg) ${USDT}`)
  assert.equal(formatPaymentAmount(10n * 10n ** 18n, usdt), `10 USDT (Binance-Peg) ${USDT}`)
  assert.equal(formatPaymentAmount(150000000n, bem), `1.5 BEM ${bem.token}`)
  assert.throws(() => formatPaymentAmount(1n), (e) => e.code === 'INVALID_ARGUMENT' && /never assumed/.test(e.message), 'no token, no decimals: refused, not 8')
  assert.throws(() => formatPaymentAmount(1n, { display: 'X' }), (e) => e.code === 'INVALID_ARGUMENT')
  // an unknown token shows its address alone / 不认识的代币只显示地址
  chain.setEscrowToken(OTHER, '0x' + 'ab'.repeat(20)); chain.setDecimals('0x' + 'ab'.repeat(20), 6 + 6)
  const unk = await api.chain.escrow.paymentToken(OTHER)
  assert.equal(unk.label, null)
  assert.equal(unk.display, unk.token)
  assert.deepEqual(Object.keys(PAYMENT_TOKENS[56]).sort(), [BEM, USDT.toLowerCase()].sort())
  assert.equal(PAYMENT_TOKENS[56][BEM].address.toLowerCase(), MAINNET.bem)
})

test('paymentToken reads under strict agreement and caches the answer per escrow, never an error', async () => {
  const chain = createFakeChain()
  const api = mk(chain)
  chain.state.calls.length = 0
  await Promise.all([api.chain.escrow.paymentToken(), api.chain.escrow.paymentToken()])
  await api.chain.escrow.paymentToken()
  const reads = chain.state.calls.filter((c) => c.name === 'token' || c.name === 'decimals')
  assert.deepEqual([...new Set(reads.map((c) => c.name))].sort(), ['decimals', 'token'])
  assert.equal(reads.filter((c) => c.name === 'token').length, 3, 'one read, answered by every one of the three operators (strict)')
  // one node down is enough to refuse under strict agreement, while the plain read takes 2 of 3
  // 严格共识：一个节点不答即拒绝；普通读取 3 取 2 即可
  const c2 = createFakeChain()
  c2.setFault('http://rpc3', 'http500')
  const api2 = mk(c2)
  assert.equal((await api2.chain.escrow.token()).toLowerCase(), BEM, 'the plain read takes the 2-of-3 quorum')
  await assert.rejects(api2.chain.escrow.paymentToken(), (e) => ['RPC_DISAGREE', 'RPC_UNAVAILABLE'].includes(e.code), 'strict: every operator must agree; a node failure stays a node failure')
  // an error is not cached: once the escrow answers, the read succeeds / 错误不缓存
  const c3 = createFakeChain(); c3.setEscrowToken(ADDR.escrow, null)
  const api3 = mk(c3)
  await assert.rejects(api3.chain.escrow.paymentToken(), unsupported('token-unreadable'))
  c3.setEscrowToken(ADDR.escrow, BEM)
  assert.equal((await api3.chain.escrow.paymentToken()).decimals, 8)
})

test('paymentToken never falls back to 8 decimals: no token(), no decimals(), or decimals outside 8..18 is UNSUPPORTED_PAYMENT_TOKEN', async () => {
  const chain = createFakeChain()
  const api = mk(chain)
  // an escrow without token(): a v2 escrow, or any other contract / 没有 token() 的托管
  chain.setEscrowToken(ESC2, null)
  await assert.rejects(api.chain.escrow.paymentToken(ESC2), unsupported('token-unreadable'))
  // token() is the zero address / token() 为零地址
  chain.setEscrowToken(OTHER, '0x' + '00'.repeat(20))
  await assert.rejects(api.chain.escrow.paymentToken(OTHER), unsupported('token-unreadable'))
  // a token without decimals() / 没有 decimals() 的代币
  const T = '0x' + 'cd'.repeat(20), E = '0x' + '43'.repeat(20)
  chain.setEscrowToken(E, T)
  await assert.rejects(api.chain.escrow.paymentToken(E), (e) => unsupported('decimals-unreadable')(e) && e.data.token.toLowerCase() === T && /never assumes 8/.test(e.message))
  chain.setDecimals(T, 2n ** 200n)
  await assert.rejects(api.chain.escrow.paymentToken(E), unsupported('decimals-unreadable'), 'not a uint8')
  for (const d of [0, 6, 7, 19, 30]) {
    const E2 = '0x' + (50 + d).toString(16).padStart(2, '0').repeat(20)
    chain.setEscrowToken(E2, T); chain.setDecimals(T, d)
    await assert.rejects(api.chain.escrow.paymentToken(E2), (e) => unsupported('decimals-out-of-range')(e) && e.data.decimals === d, `${d} decimals`)
  }
  // no rpc: a library error, not a guess / 没有 rpc：库内错误，不猜
  await assert.rejects(createTapeAPI({ escrow: ADDR.escrow }).chain.escrow.paymentToken(), (e) => e.code === 'INVALID_ARGUMENT' && /rpcUrls/.test(e.message))
})

test('AUDITED_ESCROWS is empty on every chain: no escrow is deployed or audited', () => {
  for (const id of [56, 196, 8453]) assert.deepEqual(AUDITED_ESCROWS[id], [], `chain ${id}`)
  assert.ok(Object.isFrozen(AUDITED_ESCROWS[56]))
})

// ---- approve / fund (TAPI-22 §3.5 client behaviour) / 授权与充值 ----
const PROVIDER = ADDR.container
const notAllowed = (e) => e instanceof TapeAPIError && e.code === 'INVALID_ARGUMENT' && e.data?.reason === 'escrow-not-allowed' && /allowEscrows/.test(e.message)

test('approve and fund refuse every escrow off the audited list (empty) unless the caller adds it; `escrow` is not added', async () => {
  const chain = createFakeChain()
  const api = mk(chain)
  chain.state.calls.length = 0
  await assert.rejects(api.tx.approve({ amount: 1n }), notAllowed)
  await assert.rejects(api.tx.fund(PROVIDER, 1n), notAllowed)
  const svc = { container: PROVIDER, manifest: { payment: { escrow: ESC2, unit: 'BEM' } } }
  await assert.rejects(api.tx.approve({ amount: 1n, spender: svc }), notAllowed, 'a provider-named escrow')
  await assert.rejects(api.tx.fund(svc, 1n), notAllowed)
  // the amount rule (review H-1) comes first: no amount, no read / 金额规则（H-1）最先检查：没有金额就不读链
  await assert.rejects(api.tx.approve({ spender: svc }), (e) => e.code === 'INVALID_ARGUMENT' && /needs an amount/.test(e.message))
  assert.deepEqual(chain.state.calls, [], 'refused before any read')
  // other builders are unaffected: withdrawing or settling never needs the list / 其它构造器不受影响：提现与结算不需要名单
  assert.equal(api.tx.withdraw(PROVIDER).to, ADDR.escrow)
  assert.equal(api.tx.requestWithdraw(svc, 1n).to, ESC2)
  // added: built, the spender is the escrow and the token is its token() / 添加后：构造，被授权方是托管，代币是其 token()
  const ok = mk(chain, { allowEscrows: [ADDR.escrow.toUpperCase().replace('0X', '0x')] })
  const a = await ok.tx.approve({ amount: 7n })
  assert.equal(a.to.toLowerCase(), BEM)
  assert.deepEqual(a, { to: checksumAddress(BEM), data: encodeCall('approve', [ADDR.escrow, 7n]), value: '0x0' })
  assert.deepEqual(await ok.tx.fund(PROVIDER, 7n), { to: ADDR.escrow, data: encodeCall('fund', [PROVIDER, 7n]), value: '0x0' })
  for (const bad of ['0x12', [42], ['nope'], 'x', {}]) assert.throws(() => mk(chain, { allowEscrows: bad }), (e) => e.code === 'INVALID_ARGUMENT' && /allowEscrows/.test(e.message), JSON.stringify(bad))
})

test('approve takes the token from the escrow, never a BEM default; a token the caller names must match', async () => {
  const chain = createFakeChain()
  chain.setEscrowToken(ESC2, USDT); chain.setDecimals(USDT, 18)
  const api = mk(chain, { escrow: ESC2, allowEscrows: [ESC2] })
  const a = await api.tx.approve({ amount: 10n ** 19n, token: USDT })
  assert.equal(a.to, USDT, 'the escrow\'s token()')
  assert.equal(a.data, encodeCall('approve', [ESC2, 10n ** 19n]))
  // naming BEM for a USDT escrow: refused, not an approval of the wrong token / 对 USDT 托管指定 BEM：拒绝
  await assert.rejects(api.tx.approve({ amount: 1n, token: BEM }), (e) => unsupported('token-mismatch')(e) && e.data.token === USDT && /USDT \(Binance-Peg\)/.test(e.message))
  // naming nothing: the default is BEM, so a USDT escrow is refused with the reason / 不指定：默认 BEM，USDT 托管被拒并说明原因
  await assert.rejects(api.tx.approve({ amount: 1n }), (e) => unsupported('not-bem')(e) && /not yet specified/.test(e.message))
  // fund is stricter: an allowed escrow that holds another token is refused whatever token the caller names, because the
  // SDK has no use for such a channel yet (the manifest cannot price in it) / fund 更严：无论调用方声明什么代币，持有其它代币的托管一律拒绝
  const refusedFund = (e) => unsupported('not-bem')(e) && /holds USDT/.test(e.message) && /any admitted token/.test(e.message) && /not yet specified/.test(e.message) && e.data.token === USDT
  await assert.rejects(api.tx.fund(PROVIDER, 5n, { token: USDT }), refusedFund)
  await assert.rejects(api.tx.fund(PROVIDER, 5n), refusedFund)
  await assert.rejects(api.tx.fund(PROVIDER, 5n, { token: BEM }), refusedFund)
  await assert.rejects(api.tx.fund(PROVIDER, 5n, { token: 'nope' }), (e) => e.code === 'INVALID_ARGUMENT' && /token must be an address/.test(e.message))
  // on a BEM escrow, fund still checks the token the caller names / 在持有 BEM 的托管上，fund 仍核对调用方声明的代币
  const bemApi = mk(chain, { allowEscrows: [ADDR.escrow] })
  assert.deepEqual(await bemApi.tx.fund(PROVIDER, 5n, { token: BEM }), { to: ADDR.escrow, data: encodeCall('fund', [PROVIDER, 5n]), value: '0x0' })
  await assert.rejects(bemApi.tx.fund(PROVIDER, 5n, { token: USDT }), unsupported('token-mismatch'))
})

test('fund for a service: its manifest prices in BEM, so an escrow holding another token is refused even when named', async () => {
  const chain = createFakeChain()
  chain.setEscrowToken(ESC2, USDT); chain.setDecimals(USDT, 18)
  const api = mk(chain, { allowEscrows: [ADDR.escrow, ESC2] })
  const usdtSvc = { container: PROVIDER, manifest: { payment: { escrow: ESC2, unit: 'BEM', decimals: 8 } } }
  for (const token of [undefined, USDT]) {
    await assert.rejects(api.tx.fund(usdtSvc, 5n, { token }), (e) => unsupported('not-bem')(e) && /builds fund only for an escrow that holds BEM/.test(e.message), String(token))
    await assert.rejects(api.tx.approve({ amount: 5n, spender: usdtSvc, token }), (e) => unsupported('not-bem')(e) && /manifest prices its methods in BEM/.test(e.message), String(token))
  }
  const bemSvc = { container: PROVIDER, manifest: { payment: { escrow: ADDR.escrow, unit: 'BEM', decimals: 8 } } }
  assert.equal((await api.tx.fund(bemSvc, 5n)).to, ADDR.escrow)
  assert.equal((await api.tx.approve({ amount: 5n, spender: bemSvc })).to.toLowerCase(), BEM)
})

test('an allowed escrow whose token cannot be read gets no transaction: never a guess', async () => {
  const chain = createFakeChain()
  const T = '0x' + 'cd'.repeat(20)
  chain.setEscrowToken(ESC2, null)
  chain.setEscrowToken(OTHER, T)   // T has no decimals() / T 没有 decimals()
  await assert.rejects(mk(chain, { escrow: ESC2, allowEscrows: [ESC2] }).tx.approve({ amount: 1n }), unsupported('token-unreadable'))
  await assert.rejects(mk(chain, { escrow: OTHER, allowEscrows: [OTHER] }).tx.fund(PROVIDER, 1n, { token: T }), unsupported('decimals-unreadable'))
})

test('a dev service (never for money) is not checked: a priced dev call signs and goes out without reading the escrow', async () => {
  let rpcReads = 0, posted = 0
  const fetch = async (url) => { if (String(url).startsWith('http://rpc')) { rpcReads++; throw new Error('no chain here') } posted++; throw new Error('offline') }
  const api = createTapeAPI({ dev: true, fetch })
  const svc = await api.resolve({ dev: { tapeapi: '0.1', circuits: '0x' + '00'.repeat(20), tokenId: '0', container: PROVIDER, signer: '0x' + '11'.repeat(20), delegation: null, dev: true, endpoints: { live: ['http://127.0.0.1:1/tapeapi/v1'], async: false }, methods: [{ name: 'm', priceBEM: '0.01', params: {}, returns: {} }], payment: { escrow: ESC2 } } })
  const payer = api.payer({ consumer: PROVIDER, sessionKey: '0x' + '44'.repeat(32) })
  await assert.rejects(api.call(svc, 'm', {}, { payer }), (e) => e.code === 'PROVIDER_UNAVAILABLE')
  assert.equal(rpcReads, 0); assert.equal(posted, 1, 'the request went out')
  assert.equal(payer.inflightOf(svc), 0)
})

test('no amount in the SDK or the server is parsed or shown with the 8-decimal default: every call names its decimals', () => {
  // parseUnits / formatUnits keep their 1.x default (8, BEM) for callers; inside the library every call says which
  // decimals it means: BEM_DECIMALS for priceBEM, the token's own decimals for an escrow amount.
  // parseUnits / formatUnits 对调用方保留 1.x 的默认值（8 位，BEM）；库内每次调用都写明小数位。
  const roots = ['../src/', '../../server/src/', '../bin/', '../../server/bin/']
  const bare = []
  for (const r of roots) {
    let names = []
    try { names = readdirSync(new URL(r, import.meta.url)) } catch { continue }
    for (const n of names.filter((f) => /\.(m?js)$/.test(f))) {
      const text = readFileSync(new URL(r + n, import.meta.url), 'utf8')
      for (const m of text.matchAll(/\b(parseUnits|formatUnits)\(/g)) {
        if (/export function $/.test(text.slice(Math.max(0, m.index - 16), m.index))) continue   // the definitions / 定义本身
        // the argument list up to the matching parenthesis; a call names its decimals when it has a top-level comma
        let depth = 0, i = m.index + m[0].length - 1, comma = false
        for (; i < text.length; i++) {
          const ch = text[i]
          if (ch === '(' || ch === '[' || ch === '{') depth++
          else if (ch === ')' || ch === ']' || ch === '}') { depth--; if (depth === 0) break }
          else if (ch === ',' && depth === 1) comma = true
        }
        if (!comma) bare.push(`${r}${n}:${text.slice(0, m.index).split('\n').length}`)
      }
    }
  }
  assert.deepEqual(bare, [])
})

test('tx.wrapNative: WBNB.deposit() with value, the wrapper address from the caller only, and no gas field', () => {
  const api = createTapeAPI({})
  const W = '0x' + 'bb'.repeat(20)
  const t = api.tx.wrapNative({ wbnb: W, amount: 10n ** 17n })
  assert.deepEqual(t, { to: checksumAddress(W), data: '0xd0e30db0', value: '0x16345785d8a0000' })
  assert.equal(selector('deposit()'), '0xd0e30db0')
  assert.equal('gas' in t, false, 'the wallet estimates gas: never a hard-coded 21,000')
  assert.throws(() => api.tx.wrapNative({ amount: 1n }), (e) => e.code === 'INVALID_ARGUMENT' && /ships no wrapper address/.test(e.message))
  assert.throws(() => api.tx.wrapNative({ wbnb: '0x' + '00'.repeat(20), amount: 1n }), (e) => e.code === 'INVALID_ARGUMENT')
  for (const amount of [undefined, 0n, -1n, 2n ** 256n]) assert.throws(() => api.tx.wrapNative({ wbnb: W, amount }), (e) => e.code === 'INVALID_ARGUMENT', String(amount))
})

test('no transaction the SDK builds carries a hard-coded 21,000 or 2,300 gas', () => {
  // A plain transfer's 21,000 is not enough to send the native coin to a contract (a container's receive needs about
  // 32,000, measured); the SDK leaves gas to the wallet except for ChannelBus sends, whose gas grows with the data.
  // 普通转账的 21,000 不够向合约（容器）转原生币（实测约需 32,000）；除 ChannelBus 外，SDK 把 gas 交给钱包估算。
  for (const n of readdirSync(new URL('../src/', import.meta.url)).filter((f) => f.endsWith('.js'))) {
    const text = readFileSync(new URL(`../src/${n}`, import.meta.url), 'utf8')
    assert.doesNotMatch(text, /gas\w*\s*[:=]\s*[^,\n]*\b(21_?000|2_?300|0x5208|0x8fc)\b/i, n)
  }
})

test('chain.escrow.contributions: one provider across escrow instances, with a warning when they differ (read-only)', async () => {
  const chain = createFakeChain()
  // the fake answers one contribution per provider; a second escrow answers its own through a fetch wrapper
  // 假链按提供者只存一个值；第二个托管经 fetch 包装给出自己的值
  const { functionBySelector, encodeReturn } = await import('../src/abi.js')
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body)
    const one = (req) => (req.method === 'eth_call' && req.params[0].to.toLowerCase() === ESC2 && functionBySelector(req.params[0].data) === 'contributionOf')
      ? { jsonrpc: '2.0', id: req.id, result: encodeReturn('contributionOf', [0n]) } : null
    if (!Array.isArray(body) && one(body)) return new Response(JSON.stringify(one(body)), { headers: { 'content-type': 'application/json' } })
    if (!Array.isArray(body)) return chain.fetch(url, init)
    const answers = await Promise.all(body.map(async (req) => one(req) ?? (await chain.fetch(url, { ...init, body: JSON.stringify(req) })).json()))
    return new Response(JSON.stringify(answers), { headers: { 'content-type': 'application/json' } })
  }
  chain.setContribution(PROVIDER, 100)
  const api = mk(chain, { fetch, allowEscrows: [ADDR.escrow, ESC2] })
  const r = await api.chain.escrow.contributions(PROVIDER)
  assert.deepEqual(r.readings.map((x) => [x.escrow.toLowerCase(), x.bps]), [[ADDR.escrow, 100], [ESC2, 0]], 'defaults to the allowed escrows')
  assert.equal(r.consistent, false)
  assert.match(r.warning, /differs across escrow instances: .* 100 bps, .* 0 bps.*default 100 bps/)
  const one = await api.chain.escrow.contributions(PROVIDER, [ADDR.escrow, ADDR.escrow.toUpperCase().replace('0X', '0x')])
  assert.equal(one.readings.length, 1, 'one instance listed twice is one')
  assert.deepEqual([one.consistent, one.warning], [true, null])
  // a failed read is reported, not hidden, and does not make a warning by itself / 读取失败如实报告，本身不构成警告
  chain.markLegacyEscrow(ESC2)
  const api2 = mk(chain)
  const part = await api2.chain.escrow.contributions(PROVIDER, [ADDR.escrow, ESC2])
  assert.deepEqual(part.readings.map((x) => x.bps), [100, null])
  assert.equal(part.readings[1].error, 'RPC_ERROR')
  assert.deepEqual([part.consistent, part.warning], [true, null])
  assert.deepEqual(await mk(chain).chain.escrow.contributions(PROVIDER), { provider: checksumAddress(PROVIDER), readings: [], consistent: true, warning: null }, 'no allowed escrow: nothing to compare')
  await assert.rejects(api.chain.escrow.contributions('nope'), (e) => e.code === 'INVALID_ARGUMENT')
  await assert.rejects(api.chain.escrow.contributions(PROVIDER, 'x'), (e) => e.code === 'INVALID_ARGUMENT')
})
