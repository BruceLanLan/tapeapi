#!/usr/bin/env node
// TapeOut Reader 示例 provider / Example provider: blockNumber (free), circuitHolder (paid), bemBalance (free).
//
// 这是新人读的第一个示例，所以环境变量、清单占位符、启动横幅全部原地摊开 —— 一个 provider 到底由什么
// 组成，应该在这一页上看得完。其它示例把这层完全相同的外壳收进了 `../_lib/service.mjs`。
// This is the first example a newcomer reads, so the environment variables, the manifest placeholders and the
// start-up banner are all spelled out here: what a provider is made of should fit on one page. The other
// examples carry the identical shell and factor it into `../_lib/service.mjs`.
import { readFile } from 'node:fs/promises'
import { createProvider } from '@tapeapi/server'
import { abi, sig, formatUnits, BEM_DECIMALS, MAINNET, rpcUrlsFor } from '@tapeapi/sdk'

const here = new URL('.', import.meta.url)
const manifest = JSON.parse(await readFile(new URL('manifest.json', here), 'utf8'))

// ---- env ----
const PORT = Number(process.env.PORT || 8787)
// Default: the SDK's nodes, three distinct operators (quorums count operators) / 默认：SDK 的三家运营方节点
const RPC_URLS = (process.env.RPC_URLS || rpcUrlsFor(56).join(',')).split(',').map(s => s.trim()).filter(Boolean)
const QUORUM = Number(process.env.QUORUM || Math.min(2, RPC_URLS.length))
const CHAIN_ID = Number(process.env.CHAIN_ID || 56)
const BEM = process.env.BEM || MAINNET.bem
const PROD = !!(process.env.DELEGATION_SIG && process.env.DELEGATION_EXPIRES)
let SIGNER_KEY = process.env.SIGNER_KEY
if (!SIGNER_KEY) {
  if (PROD) { console.error('[reader] SIGNER_KEY is required when DELEGATION_SIG is set (the delegation names a fixed signer)'); process.exit(1) }
  SIGNER_KEY = sig.randomPrivateKey() // 临时 signer，私钥不打印 / ephemeral signer; the key is never printed (review L-22)
  console.log('[reader] no SIGNER_KEY set; using an ephemeral signer for this run (set SIGNER_KEY to keep a stable signer)')
}
const signer = sig.privateKeyToAddress(SIGNER_KEY)

// 用环境变量覆盖占位符 / Fill manifest placeholders from env.
manifest.signer = signer
if (process.env.CONTAINER) manifest.container = process.env.CONTAINER
if (process.env.CIRCUITS) manifest.circuits = process.env.CIRCUITS
if (process.env.TOKEN_ID) manifest.tokenId = String(process.env.TOKEN_ID)
if (process.env.ESCROW) manifest.payment.escrow = process.env.ESCROW
manifest.endpoints.live = [(process.env.PUBLIC_URL || `http://127.0.0.1:${PORT}`).replace(/\/+$/, '') + '/tapeapi/v1']
if (PROD) {
  manifest.delegation = { expires: Number(process.env.DELEGATION_EXPIRES), sig: process.env.DELEGATION_SIG }
  manifest.dev = false
} else {
  manifest.delegation = null // dev 模式：还没有 holder 委托 / dev mode: no holder delegation yet
  manifest.dev = true
}
// 本地调试：把收费方法降为免费，这样没有链也能走完调用路径（只在 dev 清单上生效）。
// Local debugging: make the paid methods free so the call path works without a chain (dev manifests only).
if (manifest.dev && process.env.FREE_ALL === '1') for (const m of manifest.methods) m.priceBEM = '0'

// 上线时端点必须是 https://（TAP-20 §3.4）。默认的 http://127.0.0.1 在 PROD 下会被清单校验拒绝，
// 与其抛一段栈，不如在这里说清楚要设什么。 / Going live requires an https:// endpoint (TAP-20 §3.4).
// The default http://127.0.0.1 is refused by manifest validation once PROD is on; say what to set
// instead of throwing a stack trace. (cold-start test 2026-09-21)
if (PROD && !process.env.PUBLIC_URL) {
  console.error('[reader] DELEGATION_SIG is set (going live), but PUBLIC_URL is not.')
  console.error('[reader] A live manifest MUST advertise an https:// endpoint. Set PUBLIC_URL=https://your.host')
  console.error('[reader] and put a TLS terminator in front of this process, or unset DELEGATION_SIG to stay in dev mode.')
  process.exit(1)
}

const provider = createProvider({
  manifest, signerKey: SIGNER_KEY, rpcUrls: RPC_URLS, quorum: QUORUM, chainId: CHAIN_ID,
  allowSingleNode: !PROD, // 生产环境 urls 少于 quorum 拒绝启动（M-11）/ production refuses fewer urls than quorum
  log: (...a) => console.error('[reader]', ...a),
  methods: {
    // 免费：当前区块 / free: current block
    blockNumber: async (_params, ctx) => ({ blockNumber: ctx.block }),
    // 收费：读 ownerOf / paid: circuit holder via IERC721.ownerOf
    circuitHolder: async ({ circuits, tokenId }) => {
      if (!abi.isAddress(circuits)) throw Object.assign(new Error('circuits must be address'), { code: 'BAD_REQUEST' })
      if (!/^\d+$/.test(String(tokenId))) throw Object.assign(new Error('tokenId must be decimal string'), { code: 'BAD_REQUEST' })
      const holder = abi.decodeReturn('ownerOf', await provider.rpc.ethCall(circuits, abi.encodeCall('ownerOf', [BigInt(tokenId)])))
      return { holder }
    },
    // 免费：BEM 余额。BEM 链上是 8 位小数（BEM_DECIMALS），不是 18 —— 按 18 算会差 10^10 倍。
    // free: BEM ERC-20 balance. BEM has 8 decimals on chain, not 18; assuming 18 is a 10^10 error.
    bemBalance: async ({ address }) => {
      if (!abi.isAddress(address)) throw Object.assign(new Error('address must be address'), { code: 'BAD_REQUEST' })
      const raw = abi.decodeReturn('balanceOf', await provider.rpc.ethCall(BEM, abi.encodeCall('balanceOf', [address])))
      return { balance: formatUnits(raw, BEM_DECIMALS), raw: raw.toString() }
    },
  },
})

// 默认只听回环：绑 0.0.0.0 会让同一个 wifi 下的任何人都能调用，而免费方法没有任何限流。
// 要对外暴露就显式设 HOST=0.0.0.0，并且自己负责前面那层。 / Bind loopback by default: 0.0.0.0 exposes the
// process to everyone on the same network, and free methods have no rate limiting. Opt in with HOST=0.0.0.0.
const HOST = process.env.HOST || '127.0.0.1'
const server = await provider.listen(PORT, HOST)
const { port } = server.address()
// PORT=0 时真实端口到这里才知道；provider 持有的是同一个 manifest 对象，改它就等于改对外公布的端点。
// With PORT=0 the real port is only known now; the provider serves this very object, so patching it here
// is what the manifest advertises.
if (!process.env.PUBLIC_URL) manifest.endpoints.live = [`http://127.0.0.1:${port}/tapeapi/v1`]
console.log(`[reader] ${manifest.name} listening on http://${HOST}:${port}` + (HOST === '0.0.0.0' ? '  (all interfaces: reachable from your network; behind a proxy, set clientIpHeader or every caller shares one rate-limit bucket)' : ''))
console.log(`[reader] signer   ${signer}`)
console.log(`[reader] container ${manifest.container}  escrow ${manifest.payment.escrow}  dev=${manifest.dev}`)
console.log(`[reader] manifest http://127.0.0.1:${port}/.well-known/tapeapi.json`)
console.log(`[reader] rpc      ${RPC_URLS.join(', ')} (quorum ${QUORUM})`)

// 定期打印待结算 / Periodically report pending settlements.
setInterval(async () => {
  const pending = await provider.pendingSettlements()
  if (pending.length) console.log(`[reader] pending settlements: ${pending.map(v => `${v.consumer}=${formatUnits(v.cumulative)} BEM`).join(', ')}`)
}, 60_000).unref()

for (const s of ['SIGINT', 'SIGTERM']) process.on(s, async () => { await provider.close(); process.exit(0) })
