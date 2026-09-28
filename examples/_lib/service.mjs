// 示例 provider 的外壳：环境变量、清单占位符、启动横幅、优雅关闭。
// The shell every example provider wears: environment variables, manifest placeholders, the start-up banner
// and a clean shutdown. Only the parts that differ between examples stay in the example itself.
//
// `examples/reader-service` 刻意**不用**这个模块：它是新人读的第一个示例，那 30 行外壳必须摊开在眼前，
// 而不是三次跳进这里。其它八个示例的外壳完全相同，收在这里。
// `examples/reader-service` deliberately does NOT use this module: it is the first example a newcomer reads,
// and its shell has to be visible on the page rather than three calls into a library. The other eight carry
// an identical shell, which lives here.
import { sig, rpcUrlsFor } from '@tapeapi/sdk'
import { fileStore } from './store.mjs'
import { createSender, createSettler } from './sendtx.mjs'

const list = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean)
// 2-of-3 operators (QUORUM defaults to 2): one down, rate limiting or refusing a method still leaves a quorum (arch A5).
// The SDK's defaults, three distinct operators; quorums count operators, not URLs.
// 三家取二（QUORUM 默认 2）：一家宕机、限流或拒绝某方法时仍有法定数。SDK 默认节点，三家不同运营方；法定数按运营方计。
const DEFAULT_RPC_URLS = rpcUrlsFor(56).join(',')

/**
 * 读取所有示例共用的环境变量，并决定用哪把 signer 私钥。
 *   PORT, HOST, RPC_URLS, QUORUM, CHAIN_ID, BLOCK_LAG, SIGNER_KEY, DELEGATION_SIG, DELEGATION_EXPIRES
 *
 * `PROD` 的判据是「持有人已经出具了委托」：一旦委托签名把某个 signer 地址签进去了，就不能再换一把
 * 临时钥匙（签出来的信封谁也验不过），所以那种情况下缺 SIGNER_KEY 直接拒绝启动。
 * `PROD` means "the holder has issued a delegation". A delegation names one fixed signer address, so an
 * ephemeral key would sign envelopes nobody can verify — hence the refusal to start without SIGNER_KEY.
 *
 * @param {string} tag 日志前缀，如 'twap' / the log prefix, e.g. 'twap'
 * @param {{ port: number, lag?: number }} defaults 该示例的默认端口与后备滞后块数 / this example's defaults
 */
export function exampleEnv(tag, { port, lag = 15, env = process.env } = {}) {
  const PORT = Number(env.PORT || port)
  const RPC_URLS = list(env.RPC_URLS || DEFAULT_RPC_URLS)
  const QUORUM = Number(env.QUORUM || Math.min(2, RPC_URLS.length))
  const CHAIN_ID = Number(env.CHAIN_ID || 56)
  const LAG = Number(env.BLOCK_LAG ?? lag)
  const PROD = !!(env.DELEGATION_SIG && env.DELEGATION_EXPIRES)
  const log = (...a) => console.error(`[${tag}]`, ...a)

  let SIGNER_KEY = env.SIGNER_KEY
  if (!SIGNER_KEY) {
    if (PROD) {
      console.error(`[${tag}] SIGNER_KEY is required when DELEGATION_SIG is set (the delegation names a fixed signer)`)
      process.exit(1)
    }
    // 临时 signer，私钥永不打印 / ephemeral signer; the key itself is never printed (review L-22)
    SIGNER_KEY = sig.randomPrivateKey()
    console.log(`[${tag}] no SIGNER_KEY set; using an ephemeral signer for this run (set SIGNER_KEY to keep a stable signer)`)
  }
  // METER_FILE keeps the meter across a restart; without it unsettled vouchers die with the process.
  // SETTLER_KEY is the key that pays gas to settle them. Both are opt-in: an example must not touch the disk
  // or send a transaction because someone ran it.
  // METER_FILE 让计量熬过重启；没有它，未结算凭证会随进程一起消失。SETTLER_KEY 是结算时付 gas 的密钥。
  // 两者都需显式开启：示例不能因为有人跑了一下就写磁盘或发交易。
  const store = env.METER_FILE ? fileStore(env.METER_FILE) : undefined
  return { tag, PORT, HOST: env.HOST || '127.0.0.1', RPC_URLS, QUORUM, CHAIN_ID, LAG, PROD, SIGNER_KEY, signer: sig.privateKeyToAddress(SIGNER_KEY), env, log, store }
}

/**
 * 用环境变量填掉清单里的占位符，**就地修改**：`createProvider` 保留的是同一个对象引用，
 * 启动后还会再改一次 `endpoints.live`（PORT=0 时真实端口只有 listen 之后才知道）。
 * Fill the manifest's placeholders from the environment, mutating in place: `createProvider` keeps this very
 * object and `startProvider` patches `endpoints.live` once more after listen (PORT=0 only resolves then).
 *
 * 没有 DELEGATION_SIG 就是 dev 清单：`delegation: null` + `dev: true`，消费者必须
 * `createTapeAPI({ dev: true })` 才能解析它。`FREE_ALL=1` 只在 dev 下生效，把所有方法降为免费，
 * 这样没有链也能跑完收费方法的调用路径。
 * Without a delegation this is a dev manifest (`delegation: null`, `dev: true`), which a consumer can only
 * resolve with `createTapeAPI({ dev: true })`. `FREE_ALL=1` applies in dev only and makes every method free,
 * so the paid call path can be exercised without a chain.
 */
export function applyEnvToManifest(manifest, { signer, PORT, env = process.env, PROD }) {
  manifest.signer = signer
  if (env.NAME) manifest.name = env.NAME
  if (env.CONTAINER) manifest.container = env.CONTAINER
  if (env.CIRCUITS) manifest.circuits = env.CIRCUITS
  if (env.TOKEN_ID) manifest.tokenId = String(env.TOKEN_ID)
  if (env.ESCROW) manifest.payment.escrow = env.ESCROW
  manifest.endpoints.live = [liveEndpoint(env.PUBLIC_URL, PORT)]
  if (PROD) { manifest.delegation = { expires: Number(env.DELEGATION_EXPIRES), sig: env.DELEGATION_SIG }; manifest.dev = false }
  else { manifest.delegation = null; manifest.dev = true }
  if (manifest.dev && env.FREE_ALL === '1') for (const m of manifest.methods) m.priceBEM = '0'
  return manifest
}

const liveEndpoint = (publicUrl, port) => (publicUrl || `http://127.0.0.1:${port}`).replace(/\/+$/, '') + '/tapeapi/v1'

/**
 * 监听、修正端点、打印横幅、装好 SIGINT/SIGTERM。返回 `http.Server`。
 * Listen, fix up the advertised endpoint, print the banner and install the signal handlers.
 *
 * @param {object} provider `createProvider(...)` 的返回值 / what `createProvider(...)` returned
 * @param {{ lines?: string[], onShutdown?: () => Promise<void> }} opts
 *        lines: 横幅里该示例特有的补充行 / this example's own extra banner lines
 *        onShutdown: 关闭前要等的事情（例如把盘上的存档写完）/ awaited before closing (e.g. flush a save file)
 */
export async function startProvider(provider, { tag, PORT, HOST, env = process.env }, { lines = [], onShutdown } = {}) {
  // TAP-22 §3.3.1: a paid provider must settle before a consumer's withdraw request becomes executable and
  // before a voucher or its session key expires. Nothing else does this for it.
  // TAP-22 §3.3.1：收费提供者必须在消费者的提现请求可执行之前、在凭证或会话密钥过期之前完成结算。没有别人代劳。
  let settler = null
  const priced = (provider.manifest.methods || []).some((m) => (m.priceBEM ?? '0') !== '0')
  if (env.SETTLER_KEY) {
    const sender = createSender({ rpcUrl: env.SETTLE_RPC_URL || (env.RPC_URLS || '').split(',')[0] || rpcUrlsFor(56)[0], privateKey: env.SETTLER_KEY, chainId: Number(env.CHAIN_ID || 56) })
    settler = createSettler({ provider, sender, intervalMs: Number(env.SETTLE_INTERVAL_MS || 60_000), log: (l) => console.error(`[${tag}] settler:`, l) }).start()
    lines = [...lines, `settler  on, from ${sender.from} every ${Math.round(Number(env.SETTLE_INTERVAL_MS || 60_000) / 1000)} s`]
  } else if (priced && !provider.manifest.dev) {
    lines = [...lines, 'settler  OFF: set SETTLER_KEY (and METER_FILE) or nothing will ever be settled on chain']
  }
  const manifest = provider.manifest
  const server = await provider.listen(PORT, HOST)
  const { port } = server.address()
  // PORT=0 时真实端口到这里才知道，清单必须跟着改（provider 持有同一个对象）。
  // With PORT=0 the real port is only known now, and the manifest must follow (the provider serves this object).
  if (!env.PUBLIC_URL) manifest.endpoints.live = [liveEndpoint(null, port)]
  console.log(`[${tag}] ${manifest.name} listening on http://${HOST}:${port}` + (HOST === '0.0.0.0' ? '  (all interfaces; behind a proxy, set clientIpHeader or every caller shares one rate-limit bucket)' : ''))
  console.log(`[${tag}] signer   ${provider.signer}   container ${provider.container}   dev=${manifest.dev}`)
  console.log(`[${tag}] manifest http://127.0.0.1:${port}/.well-known/tapeapi.json`)
  for (const l of lines) console.log(`[${tag}] ${l}`)
  for (const s of ['SIGINT', 'SIGTERM']) {
    process.on(s, async () => {
      settler?.stop()
      if (onShutdown) await onShutdown()
      await provider.close()           // let in-flight paid calls finish and commit first / 先让在途付费调用完成并记账
      provider.store?.flush?.()        // the meter is money: write it out before exiting (review L-1) / 计量就是钱，退出前落盘
      process.exit(0)
    })
  }
  return server
}

/** 横幅里的 RPC 一行：只显示主机名，绝不显示带 key 的完整 URL / hostnames only, never a keyed URL. */
export const rpcSummary = (urls, quorum, extra = '') =>
  `rpc      ${urls.map((u) => new URL(u).hostname).join(', ')} (quorum ${quorum}${extra})`
