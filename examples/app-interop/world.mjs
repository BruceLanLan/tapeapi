// examples/app-interop: the local world. Two apps and one user, on the SDK's FAKE chain (a test helper: an in-process
// JSON-RPC; nothing is on BNB Smart Chain and nothing leaves this process):
//   app A    container #12, name 12.7.tape: the caller (app-a.mjs). A static site needs no key to CALL.
//   app B    container #13, name 13.7.tape: the called app. Its manifest is a file of its own site
//            (.well-known/tapeapi.json); its signer key answers at https://app-b.example, served in process by
//            createProvider (no port). B prices `quote` and names the escrow E in payment.escrow.
//   user U   a plain wallet (no container). Its transactions are "included" by the escrow MODEL
//            (sdk/test/helpers/escrow-model.mjs), which decodes their calldata; nothing is signed or broadcast.
//   escrow E the TAPI-22 escrow, MODELLED: the contract is neither audited nor deployed (no mainnet use).
// FAKE KEYS, FOR THIS FAKE CHAIN ONLY: every key here is a test fixture made of repeated bytes. Never put a real key here.
// 本地世界：两个应用加一个用户，在 SDK 的**假链**上（测试辅助，进程内的 JSON-RPC，任何真链上都没有，也不出本进程）。
// A 是调用方（#12）；B 是被调用方（#13），清单是它自己站点里的文件，签名端点 https://app-b.example 由 createProvider 在进程内提供；
// U 是普通钱包（没有容器），它的交易由托管**模型**按 calldata 执行，不签名、不广播；托管 E 是模型：合约未审计、未部署。
// **密钥都是假链夹具**（重复字节），绝不要放真实密钥。
import { createProvider } from '@tapeapi/server'
import { sig, abi, parseUnits } from '@tapeapi/sdk'
import { createRpc } from '@tapeapi/sdk/rpc'
import { grantMethods, grantRevokeHandler, memoryGrantStore, chainReadsFromApi, withGrant, grantDigest, grantRevocationDigest } from '@tapeapi/interop'
import { standardWorld, KEYS, AG, S, NOW, RPC, BEM_TOKEN, escrowContract, addrOf, ADDR } from '../../sdk/test/helpers/agent-chain.mjs'
import { createEscrowModel } from '../../sdk/test/helpers/escrow-model.mjs'
import { activationLayer } from '../../sdk/test/helpers/activation-chain.mjs'
import { createAppB, B_METHODS } from './app-b.mjs'

const MANIFEST_PATH = '.well-known/tapeapi.json'
export const B_ORIGIN = 'https://app-b.example'
/** B's second endpoint (only with `secondEndpoint: true`), served by the same provider / B 的第二个端点 */
export const B_ORIGIN_2 = 'https://app-b-2.example'
export const ESCROW = abi.checksumAddress('0x' + '00'.repeat(18) + 'e5c0')
export const PRICE = parseUnits('0.0001')                       // 10_000 (BEM has 8 decimals)
export const USER_KEY = '0x' + '3a'.repeat(32)                  // fake-chain fixture / 假链夹具
export const USER = addrOf(USER_KEY)
export const APP_A = { container: AG, name: '12.7.tape' }
export const APP_B = { container: S, name: '13.7.tape' }
/** the visitor-grant domain's verifyingContract: this fake chain's DeWEB hub / 授权域的 hub */
export const HUB = ADDR.hub
export const CHAIN_ID = 56

// TIME: one clock, moved only by advance(). createProvider signs with Date.now, so Date.now is held at the same time while
// a world is open; close() puts the real one back (call it in afterEach). As in examples/agent-service/demo-world.mjs.
// 时间：只有一个时钟，只由 advance() 推进；createProvider 用 Date.now 签名，所以世界开着时 Date.now 被钉在同一时刻，close() 复原。
const realNow = Date.now
export const restoreTime = () => { Date.now = realNow }

// Options for the tests: `grantAware: false` is a B that does not know visitor grants (its handlers unwrapped: it ignores
// the member, as any server that only reads TAP-13's four members does); `bHandlers` replaces some of B's handlers;
// `grantOptions`, `providerOptions` and `storeOptions` are added to B's grantMethods, createProvider and memoryGrantStore
// options; `secondEndpoint` gives B's manifest a second live endpoint (B_ORIGIN_2) served by the same provider.
// 测试用选项：grantAware: false 是不认识访客授权的 B（处理器不包装，忽略该成员）；bHandlers 替换 B 的部分处理器；
// grantOptions、providerOptions、storeOptions 并入 B 的 grantMethods、createProvider、memoryGrantStore 选项；secondEndpoint 给 B 的清单加第二个端点。
export function createInteropWorld({ userBalance = 10n ** 12n, grantAware = true, bHandlers = {}, grantOptions = {}, providerOptions = {}, storeOptions = {}, secondEndpoint = false } = {}) {
  // CLIENTS: every SDK client of this world reads the fake chain the 1.x way, and says so with `dev: true` (since 2.0 that
  // means the 1.x resolution, and it is not deprecated). `conform: undefined` drops the deprecated `conform: false` the shared
  // test helper passes. `conform: 'tap10'` (the 2.0 default) is not possible here: this fake chain's hub, factory and site
  // registry are not the addresses TAP-10 lists, and a 2.0 client refuses them when it is made. `warnings` keeps what the
  // clients report (a test checks that none is DEPRECATED).
  // 客户端：本世界的 SDK 客户端都按 1.x 方式读假链，并用 dev: true 写明（2.0 起即 1.x 解析，未弃用）；conform: undefined 去掉
  // 测试辅助传入的已弃用 conform: false。这里不能用 conform: 'tap10'：假链的 hub、factory、站点注册表不是 TAP-10 列出的地址。
  const warnings = []
  const client = (extra) => x.api({ dev: true, conform: undefined, onWarning: (w) => warnings.push(w), ...extra })
  let clockS = NOW
  const clock = () => clockS
  Date.now = () => clockS * 1000
  const x = standardWorld()

  // B's manifest: its own methods, endpoint and escrow; the delegation is untouched, so it still verifies
  // B 的清单：自己的方法、端点与托管；委托不动，仍然有效
  escrowContract(x, ESCROW, BEM_TOKEN)
  const read = () => JSON.parse(new TextDecoder().decode(x.chain.state.files.get(`${S.toLowerCase()}:${MANIFEST_PATH}`).bytes))
  const manifest = { ...read(), name: 'App B', endpoints: { live: [`${B_ORIGIN}/tapeapi/v1`, ...(secondEndpoint ? [`${B_ORIGIN_2}/tapeapi/v1`] : [])], async: false }, methods: B_METHODS, payment: { escrow: ESCROW, unit: 'BEM', decimals: 8 } }
  x.chain.writeFile(S, MANIFEST_PATH, JSON.stringify(manifest))

  const appB = createAppB()
  // B's visitor-grant check (@tapeapi/interop, experimental): its own store (count, replay, revocation; one
  // process), and its own chain reads (the holders, A's name, EIP-1271), cached 60 s as TAP-10 §11 allows. B reads the
  // fake chain directly, like its voucher checks. / B 的访客授权核验：自己的存储与读链（缓存 60 秒）
  // The grant reads go through the SDK's TAP-10 site status (pinned block, opened, activated), as the 2.0 default reads
  // a name: this fake chain gets a DomainBinding in front of it (both apps activated; `activation` changes that).
  // 授权读链经 SDK 的 TAP-10 站点状态（钉块、开通、激活），与 2.0 默认读名字相同：假链前面加一个 DomainBinding（两个应用都已激活）。
  const activation = activationLayer(x.fetch, { chainId: CHAIN_ID })
  const grantStore = memoryGrantStore({ clock, ...storeOptions })
  const reads = chainReadsFromApi(client({ fetch: activation.fetch, clock }), { rpc: createRpc({ urls: RPC, fetch: x.fetch }), chainId: CHAIN_ID, clock })
  // `chainFault` (tests): the next chain reads of B fail, as an unreachable node would / 测试：B 的下几次读链失败
  const fault = { reads: 0 }
  const faulty = (f) => async (...a) => { if (fault.reads > 0) { fault.reads--; throw new Error('rpc unavailable (test fault)') } return f(...a) }
  const bChain = { holderOf: faulty(reads.holderOf), resolveName: faulty(reads.resolveName), isValidSignature: faulty(reads.isValidSignature) }
  const grantOpts = { chainId: CHAIN_ID, hub: HUB, name: APP_B.name, store: grantStore, chain: bChain, clock, ...grantOptions }
  const handlers = { ...appB.methods, ...bHandlers, grant_revoke: grantRevokeHandler(grantOpts) }
  const methods = grantAware ? grantMethods(handlers, grantOpts) : handlers
  // B reads the fake chain to check vouchers (session, channel, claimed, pending withdraw), with no cache: every check
  // sees the chain as it is now / B 读假链核对凭证，不缓存
  const provider = createProvider({
    manifest, signerKey: KEYS.providerSigner, methods, rateLimit: false, log: () => {},
    rpcUrls: RPC, quorum: 2, fetch: x.fetch, chainId: 56, escrowCacheMs: 0, sessionCacheMs: 0, allowMemoryStore: true, ...providerOptions,
  })

  // one fetch for everything, every URL recorded: the fake chain's nodes, and B's endpoint served in process.
  // `tamper(url, body)` (tests) may rewrite B's answers on the way, as a hostile network would.
  // 一个 fetch 管所有，记下每个网址；tamper 可在路上改写 B 的回答（模拟不可信的网络）
  const requests = []
  const toB = []                                                     // what B received: { url, headers, body } / B 收到了什么
  const fromB = []                                                   // what B answered, as bytes on the wire / B 回答的原始字节
  let tamper = null
  let drop = 0
  const fetch = async (url, init) => {
    const u = String(url)
    requests.push(u)
    if (u.startsWith(B_ORIGIN + '/') || (secondEndpoint && u.startsWith(B_ORIGIN_2 + '/'))) {
      toB.push({ url: u, headers: Object.fromEntries(new Headers(init?.headers ?? {})), body: String(init?.body ?? '') })
      const res = await provider.handleRequest(new Request(u, init), { clientIp: '127.0.0.1' })
      const text = await res.text()
      fromB.push(text)
      // `dropAnswers(n)` (tests): B served the call, but its answer is lost on the way back / B 已处理，回答在回程丢失
      if (drop > 0) { drop--; throw new TypeError('fetch failed: the answer was lost on the way back (test)') }
      if (!tamper) return new Response(text, { status: res.status, headers: res.headers })
      return new Response(await tamper(u, text), { status: res.status, headers: res.headers })
    }
    return x.fetch(url, init)
  }

  // A's client fetch: requests registered for a visitor grant get the top-level `grant` member, all others pass through
  // byte for byte (@tapeapi/interop withGrant) / A 的 fetch：登记过的请求加 grant 成员，其余原样转发
  const grants = withGrant(fetch, { clock })

  // the user's wallet: BEM to fund with; signs typed data (eth_signTypedData_v4: the digest of the payload it is shown)
  // and "sends" escrow transactions through the model / 用户钱包：有 BEM；签类型数据；交易由模型执行
  x.chain.setBalance(USER, userBalance)
  const escrow = createEscrowModel(x, { escrow: ESCROW, token: BEM_TOKEN, clock })
  const typedDigestOf = (p) => p.primaryType === 'VisitorGrant' ? grantDigest(p.domain.chainId, p.domain.verifyingContract, p.message) : grantRevocationDigest(p.domain.chainId, p.domain.verifyingContract, p.message)
  const wallet = {
    address: USER,
    send: (tx) => escrow.send(USER, tx),
    shown: [],                                                       // every payload the wallet showed / 钱包显示过的载荷
    signTypedData: (payload) => { wallet.shown.push(payload); return sig.signDigest(typedDigestOf(payload), USER_KEY) },
  }

  const world = {
    x, clock, fetch, requests, toB, fromB, provider, appB, wallet, escrow, manifest, grants, grantStore, bChain, warnings, activation,
    chainFault: (n = 1) => { fault.reads = n },
    advance: (seconds) => { clockS += seconds },
    close: restoreTime,
    setTamper: (fn) => { tamper = fn },
    dropAnswers: (n = 1) => { drop = n },
    /** app A's client (resolve, call, payer), on the grant-aware fetch / A 的客户端（经授权感知的 fetch） */
    apiA: () => client({ fetch: grants.fetch, clock }),
    /** app A's chain reads for building a visitor grant (its own name, B's holder) / A 构造访客授权用的读链 */
    chainA: () => chainReadsFromApi(client({ fetch: activation.fetch, clock }), { chainId: CHAIN_ID, clock }),
    /** the client A uses to BUILD the user's transactions; allowEscrows names E, which is not audited (local only) */
    walletApi: () => client({ fetch, clock, allowEscrows: [ESCROW] }),
    /** B settles what it holds, as its operator's settler would (anyone may send settle) / B 结算手里的凭证 */
    async settleAll() {
      const out = []
      for (const v of await provider.pendingSettlements()) { try { out.push(escrow.send(addrOf(KEYS.providerHolder), provider.settleTx(v))) } catch (e) { out.push(e.revert ?? e.message) } }
      return out
    },
  }
  return world
}
