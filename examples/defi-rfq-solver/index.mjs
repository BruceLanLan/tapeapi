#!/usr/bin/env node
// TAPI-24 Solver 参考骨架：用固定价格表 + 固定价差生成**格式合法**的 EIP-712 签名报价，
// 并提供一个区块锚定的 `inventory` 读取。没有库存、没有做市、没有风控——详见 README 第一段。
// 所有纯逻辑（定价、EIP-712、校验、报价簿）都在 `quote.mjs`，本文件只负责 env、链读与 HTTP。
//
// TAPI-24 Solver reference skeleton: a fixed price table and a fixed spread produce **well-formed** EIP-712 signed
// quotes, plus one block-pinned `inventory` read. No inventory, no market making, no risk management — see the
// first paragraph of the README. Every piece of pure logic (pricing, EIP-712, validation, the quote book) lives in
// `quote.mjs`; this file only does env, chain reads and HTTP.
import { readFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { createProvider } from '@tapeapi/server'
import { sig, abi } from '@tapeapi/sdk'
import { fixed, fixedDiv } from '../_lib/codec.mjs'
import { createChainReader, createTokenMeta, blockPinnedOf, bad } from '../_lib/chain.mjs'
import {
  selfCheck, validateConfig, buildQuote, signQuote, createQuoteBook, quoteStatus,
  QUOTE_TYPEHASH, QUOTE_TYPE_STRING, TTL_DEFAULT, QUOTE_BOOK_MAX,
} from './quote.mjs'
import { exampleEnv, applyEnvToManifest, startProvider, rpcSummary } from '../_lib/service.mjs'

const here = new URL('.', import.meta.url)
const manifest = JSON.parse(await readFile(new URL('manifest.json', here), 'utf8'))
const config = JSON.parse(await readFile(new URL(process.env.QUOTE_CONFIG || 'quote.config.json', here), 'utf8'))

// ---- env ----
const env = exampleEnv('solver', { port: 8794 })
const { RPC_URLS, QUORUM, CHAIN_ID, LAG, PROD, SIGNER_KEY, log, store } = env
// SOLVER_KEY 与 SIGNER_KEY 是**两把不同的钥匙**（TAPI-24 §4 第一条 Rationale）：
// 信封由 `signer` 签、经 TAPI-20 委托绑到容器；报价由 `solver` 签，因为 fromChain 上的 IntentEscrow
// 只会做一次 `ecrecover`，验不了任何委托。私钥同样不打印。
// SOLVER_KEY is a **different key** from SIGNER_KEY (TAPI-24 §4, first bullet): the envelope is signed by `signer`
// and bound to the container through a TAPI-20 delegation, while the quote is signed by `solver` because the
// IntentEscrow on fromChain only does one `ecrecover` and cannot verify a delegation. This key is never printed.
let SOLVER_KEY = process.env.SOLVER_KEY
if (!SOLVER_KEY) {
  SOLVER_KEY = sig.randomPrivateKey()
  console.log('[solver] no SOLVER_KEY set; quotes are signed by an ephemeral solver key for this run (set SOLVER_KEY to keep a stable solver address)')
}
const solver = sig.privateKeyToAddress(SOLVER_KEY)
if (SOLVER_KEY === SIGNER_KEY) console.error('[solver] WARNING: SOLVER_KEY equals SIGNER_KEY; TAPI-24 §4 wants the quote key and the manifest signer key to be separate')

applyEnvToManifest(manifest, env)

// ---- 启动自检：typehash 对不上就不启动 / start-up self-check: a typehash mismatch refuses to start ----
let checked
try { checked = selfCheck(); validateConfig(config) }
catch (e) { console.error(`[solver] refusing to start: ${e.message}`); process.exit(1) }
// manifest 里的 intentRfq.routes 跟着配置走 / keep the manifest's intentRfq.routes in step with the config
const quoteMethod = manifest.methods.find(m => m.name === 'quote')
if (quoteMethod) quoteMethod.intentRfq = { routes: config.routes.map(r => ({ fromChain: r.fromChain, toChain: r.toChain })) }

// ---- 链读 / chain reads ----
// 钉块与按 blockHash 求值来自 `_lib/chain.mjs`，与其它读链示例同一份实现。
// Pinning and blockHash evaluation come from `_lib/chain.mjs`, shared with the other chain-reading examples.
const chain = createChainReader({ name: 'bsc', urls: RPC_URLS, quorum: QUORUM, lag: LAG, allowSingleNode: !PROD })
const rpc = chain.rpc
const { selector, decodeParams, isAddress, checksumAddress, encodeParams, toHex, ZERO_ADDRESS } = abi
const SEL = { balanceOf: selector('balanceOf(address)'), decimals: selector('decimals()'), symbol: selector('symbol()') }
const NATIVE_SYMBOL = { 1: 'ETH', 56: 'BNB', 8453: 'ETH', 137: 'POL' }

const tokenMeta = createTokenMeta(rpc, SEL)

// 一个参数组的 hex（不带 0x），接在 selector 后面 / one encoded argument group as hex without 0x, appended to a selector
const encodeParamsHex = (types, values) => toHex(encodeParams(types, values)).slice(2)

// solver 地址在某链某块的余额。零地址 = 原生币（TAPI-24 §3.2 的约定）。
// Balances of the solver address on one chain at one pinned block. The zero address means the native coin
// (the convention of TAPI-24 §3.2). Results keep the caller's `tokens` order exactly: no dedup, no reorder.
async function readInventory({ chainId, tokens, block } = {}) {
  const cid = chainId === undefined || chainId === null ? CHAIN_ID : chainId
  if (!Number.isInteger(cid) || cid <= 0) bad('chainId must be a positive integer')
  if (cid !== CHAIN_ID) bad(`this instance only reads chain ${CHAIN_ID}; got ${cid}`)
  if (!Array.isArray(tokens) || tokens.length === 0) bad('tokens must be a non-empty array of addresses (the zero address means the native coin)')
  if (tokens.length > 32) bad('at most 32 tokens per call')
  for (const t of tokens) if (!isAddress(t)) bad(`not an address: ${String(t).slice(0, 64)}`)

  const pinned = await chain.pinBlock(block)
  const at = await chain.readAt(pinned, async (blk) => Promise.all(tokens.map(async (t) => {
    if (t.toLowerCase() === ZERO_ADDRESS) {
      const wei = BigInt(await rpc.call('eth_getBalance', [solver.toLowerCase(), blk]))
      return { token: ZERO_ADDRESS, symbol: NATIVE_SYMBOL[cid] ?? null, decimals: 18, balance: wei.toString(), formatted: fixed(wei, 18) }
    }
    const meta = await tokenMeta(t, blk)
    const raw = decodeParams(['uint256'], await rpc.ethCall(t, SEL.balanceOf + encodeParamsHex(['address'], [solver]), blk))[0]
    return { token: checksumAddress(t), symbol: meta.symbol, decimals: meta.decimals, balance: raw.toString(), formatted: fixed(raw, meta.decimals) }
  })))
  return {
    solver, chainId: cid, balances: at.value,
    blockPinned: blockPinnedOf(pinned, at.blockRef), // 总是返回 / always present
  }
}

// ---- 报价簿（进程内存，不是链上事实）/ the quote book (process memory, not an on-chain fact) ----
const book = createQuoteBook(QUOTE_BOOK_MAX)
// TAPI-24 §3.3 RECOMMENDED: quoteId = keccak256(solver ‖ random32)
const newQuoteId = () => toHex(abi.keccak256(solver.toLowerCase() + Buffer.from(randomBytes(32)).toString('hex')))

const provider = createProvider({
  manifest, signerKey: SIGNER_KEY, dev: !PROD, rpcUrls: RPC_URLS, quorum: QUORUM, chainId: CHAIN_ID, allowSingleNode: !PROD, log, store,
  methods: {
    // [no-quorum]：每次调用都有新的 quoteId 与新的 expires / a fresh quoteId and a fresh expires on every call
    quote: async (params = {}) => {
      const now = Math.floor(Date.now() / 1000)
      const { quote, escrow, domain } = buildQuote({ config, solver, params, now, quoteId: newQuoteId() })
      const { digest, signature } = signQuote(quote, domain, SOLVER_KEY)
      book.put(quote)
      return { quote, sig: signature, escrow, typehash: QUOTE_TYPEHASH, digest, domain }
    },
    // [no-quorum]：不钉块，且返回本实例自己的 `solver`，两家独立 Solver 永远不会逐字节相同
    // [no-quorum]: pins no block and returns this instance's own `solver`, so two independent solvers can never match
    routes: async () => ({
      solver,
      spreadBps: config.solverSpreadBps,
      spreadPercent: fixedDiv(config.solverSpreadBps, 100, 4), // 30 bps -> "0.3000" %
      routes: config.routes.map(r => ({
        fromChain: r.fromChain, toChain: r.toChain,
        escrow: checksumAddress(config.escrow[String(r.fromChain)]),
        pairs: r.pairs.map(p => ({
          fromToken: checksumAddress(p.fromToken), toToken: checksumAddress(p.toToken),
          fromDecimals: p.fromDecimals, toDecimals: p.toDecimals,
          rateNumerator: String(p.rateNumerator), rateDenominator: String(p.rateDenominator),
          maxAmountIn: String(p.maxAmountIn), maxAmountInFormatted: fixed(p.maxAmountIn, p.fromDecimals),
        })),
      })),
      maxAmountIn: Object.fromEntries(config.routes.flatMap(r => r.pairs.map(p => [`${r.fromChain}:${p.fromToken.toLowerCase()}`, String(p.maxAmountIn)]))),
      ttl: { min: 30, max: 120, default: TTL_DEFAULT },
    }),
    // [no-quorum]：本地簿记，`onChain` 恒为 null / local bookkeeping; `onChain` is always null
    status: async ({ quoteId } = {}) => quoteStatus(book, quoteId, Math.floor(Date.now() / 1000)),
    // [quorum]（仅限共用同一把 SOLVER_KEY 的镜像之间）/ [quorum], but only across mirrors sharing one SOLVER_KEY
    inventory: async (params = {}) => readInventory(params),
  },
})

await startProvider(provider, env, { lines: [
  `solver   ${solver}   (quotes are signed by this key, NOT by the manifest signer \u2014 TAPI-24 \u00a74)`,
  `typehash ${checked.typehash} == spec/TAPI-24.md \u00a76   keccak256("IntentEscrow") ${checked.nameHash}`,
  `routes   ${config.routes.map(r => `${r.fromChain}->${r.toChain}`).join(', ')}   spread ${config.solverSpreadBps} bps   default ttl ${TTL_DEFAULT}s`,
  `escrow   ${JSON.stringify(config.escrow)}   <- IntentEscrow is NOT deployed (TAPI-24 \u00a76/\u00a77); these are placeholders`,
  rpcSummary(RPC_URLS, QUORUM, `, default block finalized, fallback lag ${LAG}`),
  ...(process.env.PRINT_TYPE_STRING === '1' ? [`type     ${QUOTE_TYPE_STRING}`] : []),
] })
