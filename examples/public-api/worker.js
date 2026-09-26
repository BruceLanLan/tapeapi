// The public TapeAPI service (api.tapeapi.fun) as a Cloudflare Worker: the same identity and setup mode as
// examples/cloudflare-worker, with the free public methods of methods.js.
// 公共 TapeAPI 服务（api.tapeapi.fun）的 Cloudflare Worker：身份与设置模式同 examples/cloudflare-worker，方法见 methods.js。
//
// Secret: SIGNER_KEY. Variables: CIRCUITS, TOKEN_ID, CONTAINER, DELEGATION_EXPIRES, DELEGATION_SIG, PUBLIC_URL,
// RPC_URLS (kept across deploys by keep_vars). Adding or changing a method changes the manifest: republish it on chain
// with the holder console, step 7.
// 密钥 SIGNER_KEY；变量同上。增改方法会改变清单：用持有人操作台第 7 步重新上链。
import { createProvider } from '@tapeapi/server'
import { sig } from '@tapeapi/sdk'
import { setupAnswer } from '../cloudflare-worker/worker.js'
import { createChainReader } from '../_lib/chain.mjs'
import { MANIFEST_METHODS, publicMethods } from './methods.js'

const REQUIRED = ['CIRCUITS', 'TOKEN_ID', 'CONTAINER', 'DELEGATION_EXPIRES', 'DELEGATION_SIG', 'PUBLIC_URL']
const DEFAULT_RPC_URLS = 'https://bsc-rpc.publicnode.com,https://bsc-dataseed.bnbchain.org,https://bsc-dataseed1.defibit.io'
const configured = (env) => REQUIRED.every((k) => env[k]) && !!env.SIGNER_KEY

export function manifestOf(env) {
  return {
    tapeapi: '0.1',
    name: env.SERVICE_NAME || 'TapeAPI Public',
    circuits: env.CIRCUITS,
    tokenId: String(env.TOKEN_ID),
    container: env.CONTAINER,
    signer: sig.privateKeyToAddress(env.SIGNER_KEY),
    delegation: { expires: Number(env.DELEGATION_EXPIRES), sig: env.DELEGATION_SIG },
    endpoints: { live: [`${env.PUBLIC_URL.replace(/\/+$/, '')}/tapeapi/v1`], async: false },
    methods: MANIFEST_METHODS,
  }
}

export function build(env) {
  const rpcUrls = (env.RPC_URLS || DEFAULT_RPC_URLS).split(',').map((u) => u.trim()).filter(Boolean)
  // 2-of-3 and a one-block lag behind the lowest head: one node down or behind still leaves a quorum.
  // 三取二，比最低链头落后一个块：一个节点宕机或落后时仍有法定数。
  const chain = createChainReader({ name: 'bsc', urls: rpcUrls, quorum: 2, lag: 1 })
  return createProvider({
    manifest: manifestOf(env),
    signerKey: env.SIGNER_KEY,
    allowHttp: /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(env.PUBLIC_URL),
    rpcUrls, quorum: 2, chainId: 56,
    // The edge sets cf-connecting-ip and a client cannot forge it. / 该头由边缘设置，客户端无法伪造。
    rateLimit: { windowMs: 60_000, free: Number(env.RATE_FREE || 600), paid: Number(env.RATE_PAID || 6000) },
    methods: publicMethods(chain),
  })
}

let provider = null
export default {
  async fetch(request, env) {
    // Values pasted on a phone often carry a trailing space or newline. / 手机上粘贴的值常带尾随空白。
    env = Object.fromEntries(Object.entries(env || {}).map(([k, v]) => [k, typeof v === 'string' ? v.trim() : v]))
    if (!configured(env)) return setupAnswer(env, request)
    try { provider ??= build(env) } catch (e) { return setupAnswer(env, request, e.message) }
    return provider.handleRequest(request, { clientIp: request.headers.get('cf-connecting-ip') || undefined })
  },
}
