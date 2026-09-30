// TapeAPI provider as a Cloudflare Worker. / 以 Cloudflare Worker 运行的 TapeAPI 提供者。
//
// Why a Worker of its own, not a route on an existing site: Smart Placement pins a Worker near its D1 database
// instead of at the edge nearest the caller. That is right for a D1-heavy app and wrong for a signing API, which
// touches no database on the free path and should answer from the nearest edge.
// 为什么要独立的 Worker 而不是挂在现有站点的一条路由上：Smart Placement 会把 Worker 固定在靠近 D1 的位置，
// 而不是离调用方最近的边缘。那对重度使用 D1 的应用是对的，对一个免费路径上完全不碰数据库的签名 API 是错的。
//
// Secret: SIGNER_KEY. Variables (wrangler.toml, or the Cloudflare dashboard -- keep_vars keeps them across deploys):
// CIRCUITS, TOKEN_ID, CONTAINER, DELEGATION_EXPIRES, DELEGATION_SIG, PUBLIC_URL, ESCROW. The signer address is derived
// from SIGNER_KEY; SIGNER_ADDRESS, if set, must match it.
// 密钥：SIGNER_KEY。变量（wrangler.toml 或 Cloudflare 后台，keep_vars 让它们在部署之间保留）：CIRCUITS、TOKEN_ID、
// CONTAINER、DELEGATION_EXPIRES、DELEGATION_SIG、PUBLIC_URL、ESCROW。签名地址由 SIGNER_KEY 推导；若设置了 SIGNER_ADDRESS 须一致。
import { createProvider } from '@tapeapi/server'
import { sig, rpcUrlsFor } from '@tapeapi/sdk'
import { d1Store } from './d1-store.js'

const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type' }
const REQUIRED = ['CIRCUITS', 'TOKEN_ID', 'CONTAINER', 'DELEGATION_EXPIRES', 'DELEGATION_SIG', 'PUBLIC_URL']

// Setup mode: before the holder has signed the delegation the service cannot sign anything a client would accept, so
// it answers nothing but its health, which names the signer address derived from SIGNER_KEY. The holder console
// (tapeapi.fun/console) reads that address to build the delegation, so nobody types it in.
// 设置模式：持有人签委托之前，服务签出的任何东西都不会被客户端接受，所以它只回答健康检查，其中写明由 SIGNER_KEY 推导的签名地址。
// 持有人操作台（tapeapi.fun/console）读取这个地址来构造委托，无需任何人手工输入。
export function setupAnswer(env, request, problem = null) {
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...CORS } })
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })
  let signer = null
  try { signer = env.SIGNER_KEY ? sig.privateKeyToAddress(env.SIGNER_KEY) : null } catch { /* reported below / 下面报告 */ }
  const missing = [...(signer ? [] : ['SIGNER_KEY (secret)']), ...REQUIRED.filter((k) => !env[k])]
  const path = new URL(request.url).pathname.replace(/\/+$/, '')
  if (request.method === 'GET' && path === '/tapeapi/v1/health') return json(200, { ok: false, setup: true, signer, missing, ...(problem ? { problem } : {}) })
  return json(503, { ok: false, error: { code: 'DELEGATION_INVALID', message: `this service is being set up; ${problem || `missing: ${missing.join(', ')}`}` } })
}
const configured = (env) => REQUIRED.every((k) => env[k]) && !!env.SIGNER_KEY

let provider = null

function build(env) {
  const manifest = {
    tapeapi: '0.1',
    name: env.SERVICE_NAME || 'TapeAPI Reader',
    circuits: env.CIRCUITS,
    tokenId: String(env.TOKEN_ID),
    container: env.CONTAINER,
    signer: sig.privateKeyToAddress(env.SIGNER_KEY),
    delegation: { expires: Number(env.DELEGATION_EXPIRES), sig: env.DELEGATION_SIG },
    endpoints: { live: [`${env.PUBLIC_URL.replace(/\/+$/, '')}/tapeapi/v1`], async: false },
    methods: [
      { name: 'blockNumber', priceBEM: '0', params: {}, returns: { blockNumber: 'number' } },
    ],
    // Omit `payment` entirely while every method is free: a free service needs no escrow and no contract of ours.
    // 全部方法免费时整个省略 `payment`：免费服务不需要托管合约，也不需要我们的任何合约。
    ...(env.ESCROW ? { payment: { escrow: env.ESCROW, unit: 'BEM', decimals: 8 } } : {}),
  }
  if (env.SIGNER_ADDRESS && env.SIGNER_ADDRESS.toLowerCase() !== manifest.signer.toLowerCase()) throw new Error(`SIGNER_ADDRESS ${env.SIGNER_ADDRESS} does not match SIGNER_KEY (${manifest.signer})`)
  return createProvider({
    manifest,
    signerKey: env.SIGNER_KEY,
    // http only for a loopback PUBLIC_URL (local testing); a real endpoint must be https (TAPI-20)
    // 只有回环地址的 PUBLIC_URL 允许 http（本地测试）；真实端点必须是 https
    allowHttp: /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(env.PUBLIC_URL),
    // 2-of-3 operators (the SDK's defaults): one down, rate limiting or refusing a method still leaves a quorum (arch A5).
    // 三家取二（SDK 默认节点）：一家宕机、限流或拒绝某方法时仍有法定数。
    rpcUrls: env.RPC_URLS ? env.RPC_URLS.split(',') : rpcUrlsFor(56),
    // 3 s per node: a hung node must not hold every call for the 8 s default. / 每节点 3 秒。
    rpcTimeoutMs: Number(env.RPC_TIMEOUT_MS || 3000),
    quorum: 2,
    chainId: 56,
    // One D1 row per (consumer, provider) with a conditional UPDATE: the atomic compare-and-set that a
    // multi-isolate runtime needs. Without it two isolates lose each other's meter updates.
    // 每个 (消费者, 提供者) 一行 D1，配条件 UPDATE：多隔离实例运行时需要的原子比较并写入。
    // 没有它，两个隔离实例会互相丢失计量更新。
    store: env.DB ? d1Store(env.DB) : undefined,
    // The edge sets cf-connecting-ip and a client cannot forge it. / 该头由边缘设置，客户端无法伪造。
    rateLimit: { windowMs: 60_000, free: Number(env.RATE_FREE || 600), paid: Number(env.RATE_PAID || 6000) },
    methods: {
      blockNumber: async (_params, ctx) => ({ blockNumber: ctx.block }),
    },
  })
}

export default {
  async fetch(request, env) {
    // Values pasted on a phone often carry a trailing space or newline: trim every text variable (bindings are objects).
    // 手机上粘贴的值常带尾随空格或换行：修剪每个文本变量（绑定是对象，不受影响）。
    env = Object.fromEntries(Object.entries(env || {}).map(([k, v]) => [k, typeof v === 'string' ? v.trim() : v]))
    if (!configured(env)) return setupAnswer(env, request)
    // A wrong variable (a malformed signature, a lapsed delegation) is explained in setup mode, not thrown as an error
    // page: it is set from a phone, where a stack trace helps nobody. / 变量填错（签名格式不对、委托过期）时在设置模式里说明，
    // 而不是抛出错误页：这些是在手机上填的，堆栈对谁都没用。
    if (!provider) { try { provider = build(env) } catch (e) { return setupAnswer(env, request, e.message) } }
    return provider.handleRequest(request, { clientIp: request.headers.get('cf-connecting-ip') })
  },
}
